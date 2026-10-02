using System;

namespace DroidOffice.Core
{
    public static class TerminalKeys
    {
        public static string Enter(bool droidAgent, bool control, bool shift, bool alt = false, bool meta = false)
        {
            if (droidAgent && !alt && !meta && control != shift) return control ? "\u001b[13;5u" : "\u001b[13;2u";
            return alt ? "\u001b\r" : "\r";
        }
        public static string Arrow(char direction, bool applicationCursor) => "\u001b" + (applicationCursor ? "O" : "[") + direction;
        public static string Paste(string text, bool bracketed)
        {
            // Pasted text cannot terminate bracketed paste and inject a command.
            var clean = (text ?? "").Replace("\u001b", "").Replace("\0", "");
            if (clean.Length > 60000) clean = clean.Substring(0, 60000);
            return bracketed ? "\u001b[200~" + clean + "\u001b[201~" : clean;
        }
        public static string Control(char key)
        {
            var upper = char.ToUpperInvariant(key);
            return upper >= '@' && upper <= '_' ? ((char)(upper - '@')).ToString() : null;
        }
    }
}
