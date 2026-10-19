// Isolated acceptance fixture only. Plays one short, quiet stereo tone through
// its own audio session; never changes device, session or system volume.
using System;
using System.IO;
using System.Media;
internal static class WebAudioFixture {
    static void Main() {
        const int sampleRate = 48000, frames = sampleRate * 3, bytes = frames * 4;
        using (var stream = new MemoryStream()) {
            var writer = new BinaryWriter(stream);
            writer.Write(System.Text.Encoding.ASCII.GetBytes("RIFF")); writer.Write(36 + bytes); writer.Write(System.Text.Encoding.ASCII.GetBytes("WAVEfmt "));
            writer.Write(16); writer.Write((short)1); writer.Write((short)2); writer.Write(sampleRate); writer.Write(sampleRate * 4); writer.Write((short)4); writer.Write((short)16);
            writer.Write(System.Text.Encoding.ASCII.GetBytes("data")); writer.Write(bytes);
            for (int i = 0; i < frames; i++) {
                double envelope = Math.Min(1, Math.Min(i, frames - i) / 2400.0);
                writer.Write((short)(1000 * envelope * Math.Sin(2 * Math.PI * 440 * i / sampleRate)));
                writer.Write((short)(700 * envelope * Math.Sin(2 * Math.PI * 4000 * i / sampleRate)));
            }
            writer.Flush(); stream.Position = 0;
            using (var player = new SoundPlayer(stream)) player.PlaySync();
        }
    }
}
