using System;
using System.Globalization;

namespace DroidOffice.Settings
{
    // Only settings with a real runtime consumer are editable on this surface.
    public enum LocalControl
    {
        SmoothMovement, MovementDirection, MovementSpeed, Sprint, Turning,
        SnapAngle, SmoothTurnSpeed, Vignette, RenderScale, Foveation, RefreshRate, Gun,
        Blood, DominantHand, PointAndClick, Haptics, WristDisplay
    }
    public static class LocalControls
    {
        public static string Label(LocalControl control) => control switch
        {
            LocalControl.SmoothMovement => "Smooth movement", LocalControl.MovementDirection => "Movement direction",
            LocalControl.MovementSpeed => "Movement speed", LocalControl.Sprint => "Sprint",
            LocalControl.Turning => "Turning", LocalControl.SnapAngle => "Snap angle",
            LocalControl.SmoothTurnSpeed => "Smooth turn speed", LocalControl.Vignette => "Vignette while moving",
            LocalControl.RenderScale => "Render scale", LocalControl.Foveation => "Foveation",
            LocalControl.RefreshRate => "Refresh rate", LocalControl.Gun => "Gun on your back",
            LocalControl.Blood => "Blood effects", LocalControl.DominantHand => "Dominant hand",
            LocalControl.PointAndClick => "Point and click", LocalControl.Haptics => "Haptics",
            LocalControl.WristDisplay => "Wrist waiting count",
            _ => throw new ArgumentOutOfRangeException(nameof(control))
        };
        static string Number(float value) => value.ToString("0.##", CultureInfo.InvariantCulture);
        public static string Value(Preferences p, LocalControl control) => control switch
        {
            LocalControl.SmoothMovement => p.smoothMovement ? "On" : "Off",
            LocalControl.MovementDirection => p.movementDirection == MovementDirection.LeftHand ? "Movement hand" : "Head",
            LocalControl.MovementSpeed => Number(p.movementSpeed) + " m/s",
            LocalControl.Sprint => p.sprint ? "On" : "Off", LocalControl.Turning => p.turning.ToString(),
            LocalControl.SnapAngle => p.snapAngle + "°", LocalControl.SmoothTurnSpeed => Number(p.smoothTurnSpeed) + "°/s",
            LocalControl.Vignette => p.vignette.ToString(), LocalControl.RenderScale => Number(p.renderScale) + "×",
            LocalControl.Foveation => p.foveation.ToString(), LocalControl.RefreshRate => p.refreshRate + " Hz requested",
            LocalControl.Gun => p.gun ? "On" : "Off",
            LocalControl.Blood => p.blood ? "On" : "Off", LocalControl.DominantHand => p.dominantHand.ToString(),
            LocalControl.PointAndClick => p.pointAndClick ? "On" : "Off", LocalControl.Haptics => Number(p.haptics * 100) + "%",
            LocalControl.WristDisplay => p.wristDisplay ? "On" : "Off",
            _ => throw new ArgumentOutOfRangeException(nameof(control))
        };
        static int Cycle(int value, int length, int direction) => (value + (direction < 0 ? length - 1 : 1)) % length;
        public static Preferences Change(Preferences original, LocalControl control, int direction)
        {
            if (original == null) throw new ArgumentNullException(nameof(original));
            if (direction != -1 && direction != 1) throw new ArgumentOutOfRangeException(nameof(direction));
            var p = original.Copy(); p.Validate();
            switch (control)
            {
                case LocalControl.SmoothMovement: p.smoothMovement = !p.smoothMovement; break;
                case LocalControl.MovementDirection: p.movementDirection = (MovementDirection)Cycle((int)p.movementDirection, 2, direction); break;
                case LocalControl.MovementSpeed: p.movementSpeed += direction * 0.25f; break;
                case LocalControl.Sprint: p.sprint = !p.sprint; break;
                case LocalControl.Turning: p.turning = (Turning)Cycle((int)p.turning, 2, direction); break;
                case LocalControl.SnapAngle:
                    var angles = new[] { 30, 45, 60, 90 }; p.snapAngle = angles[Cycle(Array.IndexOf(angles, p.snapAngle), angles.Length, direction)]; break;
                case LocalControl.SmoothTurnSpeed: p.smoothTurnSpeed += direction * 15; break;
                case LocalControl.Vignette: p.vignette = (Strength)Cycle((int)p.vignette, 4, direction); break;
                case LocalControl.RenderScale: p.renderScale += direction * 0.25f; break;
                case LocalControl.Foveation: p.foveation = (Strength)Cycle((int)p.foveation, 4, direction); break;
                case LocalControl.RefreshRate: p.refreshRate = p.refreshRate == 90 ? 72 : 90; break;
                case LocalControl.Gun: p.gun = !p.gun; break;
                case LocalControl.Blood: p.blood = !p.blood; break;
                case LocalControl.DominantHand: p.dominantHand = p.dominantHand == Handedness.Left ? Handedness.Right : Handedness.Left; break;
                case LocalControl.PointAndClick: p.pointAndClick = !p.pointAndClick; break;
                case LocalControl.Haptics: p.haptics += direction * 0.1f; break;
                case LocalControl.WristDisplay: p.wristDisplay = !p.wristDisplay; break;
                default: throw new ArgumentOutOfRangeException(nameof(control));
            }
            p.Validate(); return p;
        }
        public static Preferences Reset(Preferences original, LocalControl[] controls)
        {
            if (original == null || controls == null) throw new ArgumentNullException();
            var p = original.Copy(); var defaults = new Preferences();
            foreach (var control in controls)
                switch (control)
                {
                    case LocalControl.SmoothMovement: p.smoothMovement = defaults.smoothMovement; break;
                    case LocalControl.MovementDirection: p.movementDirection = defaults.movementDirection; break;
                    case LocalControl.MovementSpeed: p.movementSpeed = defaults.movementSpeed; break;
                    case LocalControl.Sprint: p.sprint = defaults.sprint; break;
                    case LocalControl.Turning: p.turning = defaults.turning; break;
                    case LocalControl.SnapAngle: p.snapAngle = defaults.snapAngle; break;
                    case LocalControl.SmoothTurnSpeed: p.smoothTurnSpeed = defaults.smoothTurnSpeed; break;
                    case LocalControl.Vignette: p.vignette = defaults.vignette; break;
                    case LocalControl.RenderScale: p.renderScale = defaults.renderScale; break;
                    case LocalControl.Foveation: p.foveation = defaults.foveation; break;
                    case LocalControl.RefreshRate: p.refreshRate = defaults.refreshRate; break;
                    case LocalControl.Gun: p.gun = defaults.gun; break;
                    case LocalControl.Blood: p.blood = defaults.blood; break;
                    case LocalControl.DominantHand: p.dominantHand = defaults.dominantHand; break;
                    case LocalControl.PointAndClick: p.pointAndClick = defaults.pointAndClick; break;
                    case LocalControl.Haptics: p.haptics = defaults.haptics; break;
                    case LocalControl.WristDisplay: p.wristDisplay = defaults.wristDisplay; break;
                    default: throw new ArgumentOutOfRangeException(nameof(controls));
                }
            p.Validate(); return p;
        }
    }
}
