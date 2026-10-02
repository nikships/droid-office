using UnityEngine;

namespace DroidOffice.Spike
{
    public static class OfficeSpace
    {
        // Position/yaw proposal from section 4.5. NOT accepted until the device golden check.
        public static Vector3 ToUnity(double x, double y, double z) => new((float)x, (float)y, (float)-z);
        public static Quaternion YawToUnity(double yaw) => Quaternion.Euler(0, (float)(-yaw * Mathf.Rad2Deg), 0);
        // glTFast mirrors X; R_y(180) * mirror-X equals our mirror-Z.
        // Keep importer adaptation here, never scattered across anchors.
        public static Quaternion GltfBasis => Quaternion.Euler(0, 180, 0);
    }
}
