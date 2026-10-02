using System;
using DroidOffice.Core;
using DroidOffice.Net;
using UnityEngine;

namespace DroidOffice.World
{
    public sealed class OfficeApp : MonoBehaviour
    {
        public string developmentOrigin = "http://127.0.0.1:14600";
        public OfficeStore Store { get; private set; }
        public DevelopmentConnection Connection { get; private set; }
        public int AppliedMessages { get; private set; }
        public double ApplyBudgetMilliseconds = 1;
        void Awake()
        {
            Store = new OfficeStore();
            Connection = new DevelopmentConnection(Store);
        }
        void Start()
        {
#if UNITY_EDITOR || DEVELOPMENT_BUILD
            ConnectDevelopment();
#endif
        }
        public void ConnectDevelopment()
        {
            try { Connection.Start(new Uri(developmentOrigin)); }
            catch (Exception) { Store.Disconnect("Can't connect to this development office"); }
        }
        void Update()
        {
            try { AppliedMessages += Store.Drain(ApplyBudgetMilliseconds); }
            catch (Exception)
            {
                Connection.Dispose();
                Store.Disconnect("Office data is incompatible. Update this app.");
            }
        }
        void OnDestroy() => Connection?.Dispose();
    }
}
