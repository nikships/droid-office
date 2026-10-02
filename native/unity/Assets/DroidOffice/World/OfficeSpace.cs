using UnityEngine;

namespace DroidOffice.World
{
    public static class OfficeSpace
    {
        public static Vector3 ToUnity(double x, double y, double z) => new((float)x, (float)y, (float)-z);
        public static Vector3 ToOffice(Vector3 unity) => new(unity.x, unity.y, -unity.z);
        public static Quaternion YawToUnity(double yaw) => Quaternion.Euler(0, (float)(-yaw * Mathf.Rad2Deg), 0);
        public static double YawToOffice(float degrees) => -degrees * Mathf.Deg2Rad;
        public static Quaternion GltfBasis => Quaternion.Euler(0, 180, 0);
    }
}
