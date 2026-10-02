using System;
using Newtonsoft.Json;
using Newtonsoft.Json.Converters;

namespace DroidOffice.Settings
{
    [JsonConverter(typeof(StringEnumConverter))] public enum MovementDirection { Head, LeftHand }
    [JsonConverter(typeof(StringEnumConverter))] public enum Turning { Snap, Smooth }
    [JsonConverter(typeof(StringEnumConverter))] public enum Strength { Off, Low, Medium, High }
    [JsonConverter(typeof(StringEnumConverter))] public enum Handedness { Right, Left }
    [JsonConverter(typeof(StringEnumConverter))] public enum TextSize { Small, Medium, Large, ExtraLarge }
    public sealed class Preferences
    {
        public const int CurrentSchema = 1;
        public int schema = CurrentSchema;
        public bool smoothMovement;
        public MovementDirection movementDirection;
        public float movementSpeed = 2.5f;
        public bool sprint = true;
        public Turning turning;
        public int snapAngle = 45;
        public float smoothTurnSpeed = 90;
        public bool teleportFade = true, jump = true;
        public Strength vignette = Strength.Medium;
        public bool frostedElevator, reduceMotion, seated;
        public bool headInWallFade = true, gun, blood = true, caffeine = true;
        public float heightCm = 175, floorOffset;
        public Handedness dominantHand;
        public bool pointAndClick = true, wristDisplay = true;
        public float haptics = 1;
        public TextSize terminalTextSize = TextSize.Medium;
        public float terminalDistance = 0.9f;
        public bool cursorBlink = true;
        public float effectsVolume = 0.7f, ambienceVolume = 0.5f;
        public bool waitingPing = true;
        public float renderScale = 1;
        public Strength foveation = Strength.Medium;
        public int refreshRate = 90;
        public bool performanceOverlay;
        public Preferences Copy() => (Preferences)MemberwiseClone();
        static float Range(float value, float low, float high, float fallback) =>
            float.IsNaN(value) || float.IsInfinity(value) ? fallback : Math.Max(low, Math.Min(high, value));
        public void Validate()
        {
            schema = CurrentSchema;
            movementSpeed = Range(movementSpeed, 1, 4.6f, 2.5f);
            smoothTurnSpeed = Range(smoothTurnSpeed, 30, 180, 90);
            if (snapAngle != 30 && snapAngle != 45 && snapAngle != 60 && snapAngle != 90) snapAngle = 45;
            heightCm = Range(heightCm, 120, 220, 175); floorOffset = Range(floorOffset, -2.5f, 2.5f, 0);
            haptics = Range(haptics, 0, 1, 1); terminalDistance = Range(terminalDistance, 0.6f, 1.5f, 0.9f);
            effectsVolume = Range(effectsVolume, 0, 1, 0.7f); ambienceVolume = Range(ambienceVolume, 0, 1, 0.5f);
            renderScale = Range(renderScale, 0.75f, 2, 1); if (refreshRate != 72 && refreshRate != 90) refreshRate = 90;
            if (!Enum.IsDefined(typeof(MovementDirection), movementDirection)) movementDirection = MovementDirection.Head;
            if (!Enum.IsDefined(typeof(Turning), turning)) turning = Turning.Snap;
            if (!Enum.IsDefined(typeof(Strength), vignette)) vignette = Strength.Medium;
            if (!Enum.IsDefined(typeof(Strength), foveation)) foveation = Strength.Medium;
            if (!Enum.IsDefined(typeof(Handedness), dominantHand)) dominantHand = Handedness.Right;
            if (!Enum.IsDefined(typeof(TextSize), terminalTextSize)) terminalTextSize = TextSize.Medium;
        }
    }
}
