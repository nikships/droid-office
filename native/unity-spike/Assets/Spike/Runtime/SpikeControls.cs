using System.Collections.Generic;
using UnityEngine;
using UnityEngine.XR;
using UnityEngine.XR.OpenXR.Features.Android;

namespace DroidOffice.Spike
{
    public sealed class SpikeControls : MonoBehaviour
    {
        public Transform leftGrip, rightGrip;
        readonly List<XRDisplaySubsystem> displays = new();
        readonly Dictionary<string, bool> buttons = new();
        float nextDisplayRequest;

        void Start()
        {
#if UNITY_ANDROID && !UNITY_EDITOR
            if (!UnityEngine.Android.Permission.HasUserAuthorizedPermission("android.permission.EYE_TRACKING_FINE"))
            {
                UnityEngine.Android.Permission.RequestUserPermission("android.permission.EYE_TRACKING_FINE");
            }
#endif
        }

        void Update()
        {
            Poll(XRNode.LeftHand, leftGrip, "left");
            Poll(XRNode.RightHand, rightGrip, "right");
            if (Time.unscaledTime < nextDisplayRequest || !Application.isFocused) return;
            nextDisplayRequest = Time.unscaledTime + 30;
            SubsystemManager.GetSubsystems(displays);
            foreach (var display in displays)
            {
                if (!display.running) continue;
#if UNITY_ANDROID && !UNITY_EDITOR
                var request = display.TrySetDisplayRefreshRate(90);
                Debug.Log("U0 refresh request 90 Hz result=" + request);
                if (!UnityEngine.Android.Permission.HasUserAuthorizedPermission("android.permission.EYE_TRACKING_FINE"))
                {
                    Debug.LogError("U0 eye-tracked foveation unavailable: fine eye permission missing; no fixed-foveation fallback.");
                    continue;
                }
#endif
                display.foveatedRenderingFlags = XRDisplaySubsystem.FoveatedRenderingFlags.GazeAllowed;
                display.foveatedRenderingLevel = 0.5f;
                Debug.Log($"U0 foveation requested=0.5, apiReadback={display.foveatedRenderingLevel}; gaze-centred binding requires device diagnostic, not this readback.");
            }
        }

        void Poll(XRNode node, Transform proxy, string hand)
        {
            var device = InputDevices.GetDeviceAtXRNode(node);
            if (!device.isValid || !device.TryGetFeatureValue(CommonUsages.isTracked, out var tracked) || !tracked)
            {
                if (proxy != null) proxy.gameObject.SetActive(false);
                return;
            }
            if (proxy != null)
            {
                proxy.gameObject.SetActive(true);
                if (device.TryGetFeatureValue(CommonUsages.devicePosition, out var position)) proxy.localPosition = position;
                if (device.TryGetFeatureValue(CommonUsages.deviceRotation, out var rotation)) proxy.localRotation = rotation;
            }
            Button(device, hand, CommonUsages.menuButton);
            Button(device, hand, CommonUsages.primaryButton);
            Button(device, hand, CommonUsages.secondaryButton);
            Button(device, hand, CommonUsages.primary2DAxisClick);
            Button(device, hand, CommonUsages.primaryTouch);
            Button(device, hand, CommonUsages.secondaryTouch);
            Button(device, hand, CommonUsages.primary2DAxisTouch);
            if (Button(device, hand, CommonUsages.triggerButton))
            {
                var accepted = device.SendHapticImpulse(0, 0.45f, 0.015f);
                Debug.Log($"U0 haptic {hand} amplitude=0.45 duration_ms=15 API_accepted={accepted}; felt result not measured.");
            }
        }

        bool Button(InputDevice device, string hand, InputFeatureUsage<bool> usage)
        {
            var supported = device.TryGetFeatureValue(usage, out var value);
            var key = hand + ":" + usage.name;
            if (!buttons.TryGetValue(key, out var previous))
                Debug.Log($"U0 input {key} supported={supported} initial={value}");
            else if (previous != value)
                Debug.Log($"U0 input {key} value={value}");
            buttons[key] = value;
            return supported && value && !previous;
        }

        void OnApplicationFocus(bool focused)
        {
            buttons.Clear();
            if (focused) nextDisplayRequest = 0;
        }
    }
}
