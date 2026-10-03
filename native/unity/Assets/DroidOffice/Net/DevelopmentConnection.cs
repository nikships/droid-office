using System;
using System.IO;
using System.Net.WebSockets;
using System.Threading;
using System.Threading.Tasks;
using DroidOffice.Core;

namespace DroidOffice.Net
{
    // Protocol-1 loopback adapter. No cookies, tokens, TLS overrides or production pairing.
    public sealed class DevelopmentConnection : IDisposable
    {
        readonly OfficeStore store;
        readonly SemaphoreSlim sending = new(1, 1);
        CancellationTokenSource lifetime;
        volatile ClientWebSocket current;
        int generation;
        public string LastFailure { get; private set; }
        public DevelopmentConnection(OfficeStore store) { this.store = store; }
        public void Start(Uri origin)
        {
#if !UNITY_EDITOR && !DEVELOPMENT_BUILD
            throw new InvalidOperationException("Development admission is unavailable in release builds.");
#else
            if (origin == null || origin.Scheme != "http" || !origin.IsLoopback || !string.IsNullOrEmpty(origin.UserInfo) ||
                !string.IsNullOrEmpty(origin.Query) || !string.IsNullOrEmpty(origin.Fragment) || origin.AbsolutePath != "/")
                throw new ArgumentException("Development origin must be a secret-free HTTP loopback origin.");
            Dispose();
            lifetime = new CancellationTokenSource();
            var next = ++generation;
            store.BeginConnection(next);
            var cancellation = lifetime.Token;
            _ = Task.Run(() => Run(origin, next, cancellation));
#endif
        }
        async Task Run(Uri origin, int session, CancellationToken cancellation)
        {
            var delay = 500;
            var uri = new UriBuilder(origin) { Scheme = "ws", Path = "/ws" }.Uri;
            while (!cancellation.IsCancellationRequested)
            {
                using var socket = new ClientWebSocket();
                current = socket;
                socket.Options.SetRequestHeader("Origin", origin.GetLeftPart(UriPartial.Authority));
                socket.Options.KeepAliveInterval = TimeSpan.FromSeconds(10);
                var stage = "Connecting";
                try
                {
                    using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
                    timeout.CancelAfter(TimeSpan.FromSeconds(10));
                    await socket.ConnectAsync(uri, timeout.Token).ConfigureAwait(false);
                    delay = 500;
                    var receive = new byte[65536];
                    var terminalDecoder = new AttachedTerminalDecoder();
                    while (socket.State == WebSocketState.Open && !cancellation.IsCancellationRequested)
                    {
                        stage = "Receiving";
                        using var frame = new MemoryStream();
                        WebSocketReceiveResult result;
                        do
                        {
                            result = await socket.ReceiveAsync(new ArraySegment<byte>(receive), cancellation).ConfigureAwait(false);
                            if (result.MessageType == WebSocketMessageType.Close) throw new IOException("Office disconnected.");
                            if (result.MessageType != WebSocketMessageType.Text) throw new InvalidDataException("Unexpected frame type.");
                            if (frame.Length + result.Count > Wire.MaxFrameBytes) throw new InvalidDataException("Frame too large.");
                            frame.Write(receive, 0, result.Count);
                        } while (!result.EndOfMessage);
                        stage = "Parsing";
                        var message = Wire.Parse(frame.ToArray(), session);
                        stage = "Decoding terminal";
                        var parsed = terminalDecoder.Decode(message);
                        stage = "Queuing";
                        if (!store.Enqueue(parsed)) throw new InvalidDataException("Office backlog exceeded limit.");
                    }
                }
                catch (Exception) when (cancellation.IsCancellationRequested) { break; }
                catch (Exception error)
                {
                    // Never propagate endpoint or server exception text into user logs.
                    LastFailure = stage + ": " + (error is InvalidDataException ? error.Message : error.GetType().Name);
                    store.TransportDisconnected(session, "Reconnecting…");
                }
                finally { if (ReferenceEquals(current, socket)) current = null; }
                if (cancellation.IsCancellationRequested) break;
                try { await Task.Delay(delay, cancellation).ConfigureAwait(false); }
                catch (OperationCanceledException) { break; }
                delay = Math.Min(delay * 2, 8000);
            }
        }
        public Task<bool> SendAsync(object message, CancellationToken context = default)
        {
            var socket = current;
            var cancellation = lifetime?.Token ?? new CancellationToken(true);
            if (message == null || socket?.State != WebSocketState.Open || !store.Connected || cancellation.IsCancellationRequested || context.IsCancellationRequested)
                return Task.FromResult(false);
            var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellation, context);
            linked.CancelAfter(TimeSpan.FromSeconds(3));
            var reserved = sending.WaitAsync(linked.Token);
            return Task.Run(async () =>
            {
                var acquired = false; var writing = false;
                try
                {
                    await reserved.ConfigureAwait(false); acquired = true;
                    if (!ReferenceEquals(current, socket) || linked.IsCancellationRequested) return false;
                    var bytes = System.Text.Encoding.UTF8.GetBytes(Wire.Encode(message));
                    if (bytes.Length > Wire.MaxFrameBytes) return false;
                    linked.Token.ThrowIfCancellationRequested(); writing = true;
                    await socket.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, linked.Token).ConfigureAwait(false);
                    return true;
                }
                catch (OperationCanceledException) { if (writing) socket.Abort(); return false; }
                catch (Exception) { socket.Abort(); return false; }
                finally { if (acquired) sending.Release(); linked.Dispose(); }
            });
        }
        public bool TrySendTerminal(string workerId, int columns, int rows, string data, CancellationToken focus)
        {
            var socket = current; var session = generation; var cancellation = lifetime?.Token ?? new CancellationToken(true);
            if (socket?.State != WebSocketState.Open || !store.Connected || focus.IsCancellationRequested ||
                cancellation.IsCancellationRequested || !sending.Wait(0)) return false;
            var grid = store.AttachedTerminal(workerId)?.Grid;
            var resized = grid != null && (grid.Columns != columns || grid.Rows != rows);
            _ = Task.Run(async () =>
            {
                using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellation, focus);
                linked.CancelAfter(TimeSpan.FromSeconds(3));
                var writing = false;
                try
                {
                    if (!ReferenceEquals(current, socket)) return;
                    linked.Token.ThrowIfCancellationRequested();
                    var resize = System.Text.Encoding.UTF8.GetBytes(Wire.Encode(new DroidOffice.Protocol.ClientTermResize { workerId = workerId, cols = columns, rows = rows }));
                    var input = System.Text.Encoding.UTF8.GetBytes(Wire.Encode(new DroidOffice.Protocol.ClientTermInput { workerId = workerId, data = data }));
                    linked.Token.ThrowIfCancellationRequested(); writing = true;
                    await socket.SendAsync(new ArraySegment<byte>(resize), WebSocketMessageType.Text, true, linked.Token).ConfigureAwait(false);
                    linked.Token.ThrowIfCancellationRequested();
                    // Protocol-1 resize emits worker metadata, not a terminal
                    // keyframe. Reattach to obtain the authoritative new size.
                    if (resized)
                    {
                        var attach = System.Text.Encoding.UTF8.GetBytes(Wire.Encode(new DroidOffice.Protocol.ClientWorkerAttach { workerId = workerId }));
                        await socket.SendAsync(new ArraySegment<byte>(attach), WebSocketMessageType.Text, true, linked.Token).ConfigureAwait(false);
                        linked.Token.ThrowIfCancellationRequested();
                    }
                    await socket.SendAsync(new ArraySegment<byte>(input), WebSocketMessageType.Text, true, linked.Token).ConfigureAwait(false);
                }
                catch (OperationCanceledException) { if (writing) socket.Abort(); }
                catch (Exception) { socket.Abort(); store.TransportDisconnected(session, "Reconnecting…"); }
                finally { sending.Release(); }
            });
            return true;
        }
        public void Dispose()
        {
            lifetime?.Cancel(); lifetime?.Dispose(); lifetime = null;
            current?.Abort(); current = null;
        }
    }
}
