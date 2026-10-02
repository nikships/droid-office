using System;
using System.Diagnostics;
using System.IO;
using System.Net.Security;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Threading;
using System.Threading.Tasks;

namespace DroidOffice.Spike
{
    // Standalone synthetic fixture only. No office cookie, bearer token or password
    // is read. The production networking decision still needs the IL2CPP device run.
    public static class NetworkProbe
    {
        public static byte[] SpkiSha256(X509Certificate2 certificate)
        {
            var algorithm = Der(0x30, Join(CryptoConfig.EncodeOID(certificate.PublicKey.Oid.Value),
                certificate.PublicKey.EncodedParameters.RawData));
            var bitString = Der(3, Join(new byte[] { 0 }, certificate.PublicKey.EncodedKeyValue.RawData));
            using var sha = SHA256.Create();
            return sha.ComputeHash(Der(0x30, Join(algorithm, bitString)));
        }

        public static bool MatchesPin(X509Certificate certificate, byte[] pin)
        {
            if (certificate == null || pin == null || pin.Length != 32) return false;
            using var parsed = new X509Certificate2(certificate);
            var actual = SpkiSha256(parsed);
            var difference = 0;
            for (var i = 0; i < actual.Length; i++) difference |= actual[i] ^ pin[i];
            return difference == 0;
        }

        static byte[] Join(byte[] a, byte[] b)
        {
            var result = new byte[a.Length + b.Length];
            Buffer.BlockCopy(a, 0, result, 0, a.Length);
            Buffer.BlockCopy(b, 0, result, a.Length, b.Length);
            return result;
        }

        static byte[] Der(byte tag, byte[] value)
        {
            var length = value.Length < 128 ? new[] { (byte)value.Length }
                : value.Length < 256 ? new[] { (byte)0x81, (byte)value.Length }
                : new[] { (byte)0x82, (byte)(value.Length >> 8), (byte)value.Length };
            return Join(Join(new[] { tag }, length), value);
        }

        public static async Task<string> RunAsync(string address, string pinHex, int seconds = 15)
        {
            var uri = new Uri(address);
            if (uri.Scheme != "wss") throw new ArgumentException("The fixture must use WSS.");
            var pin = new byte[pinHex.Length / 2];
            for (var i = 0; i < pin.Length; i++) pin[i] = Convert.ToByte(pinHex.Substring(i * 2, 2), 16);
            var receive = new byte[65536];
            long bytes = 0;
            var clock = new Stopwatch();
            for (var connection = 0; connection < 3; connection++)
            {
                using var socket = new ClientWebSocket();
                socket.Options.SetRequestHeader("Authorization", "Bearer u0-synthetic-fixture");
                socket.Options.SetRequestHeader("Origin", "https://" + uri.Authority);
                socket.Options.RemoteCertificateValidationCallback = (_, certificate, _, _) => MatchesPin(certificate, pin);
                using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(seconds + 10));
                await socket.ConnectAsync(uri, timeout.Token).ConfigureAwait(false);
                clock.Start();
                var stopAt = clock.Elapsed.TotalSeconds + seconds;
                while (clock.Elapsed.TotalSeconds < stopAt)
                {
                    var frame = await socket.ReceiveAsync(new ArraySegment<byte>(receive), timeout.Token).ConfigureAwait(false);
                    if (frame.MessageType == WebSocketMessageType.Close)
                        throw new IOException("Fixture closed before receive window completed.");
                    bytes += frame.Count;
                }
                clock.Stop();
                await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "U0 sample complete", timeout.Token).ConfigureAwait(false);
            }
            return FormattableString.Invariant($"{{\"environment\":\"synthetic-host-unless-run-in-Android-player\",\"connections\":3,\"receivedBytes\":{bytes},\"receiveSeconds\":{clock.Elapsed.TotalSeconds:F3},\"MBps\":{bytes / clock.Elapsed.TotalSeconds / 1000000:F3}}}");
        }
    }
}
