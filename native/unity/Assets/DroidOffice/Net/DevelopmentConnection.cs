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
                try
                {
                    using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
                    timeout.CancelAfter(TimeSpan.FromSeconds(10));
                    await socket.ConnectAsync(uri, timeout.Token).ConfigureAwait(false);
                    delay = 500;
                    var receive = new byte[65536];
                    while (socket.State == WebSocketState.Open && !cancellation.IsCancellationRequested)
                    {
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
                        var parsed = Wire.Parse(frame.ToArray(), session);
                        if (!store.Enqueue(parsed)) throw new InvalidDataException("Office backlog exceeded limit.");
                    }
                }
                catch (Exception) when (cancellation.IsCancellationRequested) { break; }
                catch (Exception)
                {
                    // Never propagate endpoint or server exception text into user logs.
                    store.TransportDisconnected(session, "Reconnecting…");
                }
                finally { if (ReferenceEquals(current, socket)) current = null; }
                if (cancellation.IsCancellationRequested) break;
                try { await Task.Delay(delay, cancellation).ConfigureAwait(false); }
                catch (OperationCanceledException) { break; }
                delay = Math.Min(delay * 2, 8000);
            }
        }
        public async Task<bool> SendAsync(string json)
        {
            var cancellation = lifetime?.Token ?? CancellationToken.None;
            await sending.WaitAsync(cancellation).ConfigureAwait(false);
            try
            {
                var socket = current;
                if (socket?.State != WebSocketState.Open || !store.Connected) return false;
                var bytes = System.Text.Encoding.UTF8.GetBytes(json);
                if (bytes.Length > Wire.MaxFrameBytes) return false;
                await socket.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, cancellation).ConfigureAwait(false);
                return true;
            }
            finally { sending.Release(); }
        }
        public void Dispose()
        {
            lifetime?.Cancel(); lifetime?.Dispose(); lifetime = null;
            current?.Abort(); current = null;
        }
    }
}
