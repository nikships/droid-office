Shader "DroidOffice/World/Toon"
{
    // The source office's night (src/client/world/sky.ts): a dim violet hemisphere,
    // ambient and in-office neon fill, the moon as URP's main light through the
    // source's three-step toon ramp, and the nearest laptop screens throwing
    // pools of cyan light. Light sums are divided by pi like three.js's Lambert.
    Properties
    {
        _BaseMap("Surface", 2D) = "white" {}
        _BaseColor("Colour", Color) = (1,1,1,1)
        _EmissionMap("Emission map", 2D) = "white" {}
        _EmissionColor("Emission", Color) = (0,0,0,1)
        _Tint("Instance colour", Color) = (1,1,1,1)
    }
    SubShader
    {
        Tags { "RenderPipeline"="UniversalPipeline" "RenderType"="Opaque" "Queue"="Geometry" }
        Pass
        {
            Tags { "LightMode"="UniversalForward" }
            Cull Back
            ZWrite On
            HLSLPROGRAM
            #pragma vertex Vert
            #pragma fragment Frag
            #pragma target 3.5
            #pragma multi_compile_instancing
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Lighting.hlsl"
            #define MAX_SCREENS 8
            TEXTURE2D(_BaseMap); SAMPLER(sampler_BaseMap);
            TEXTURE2D(_EmissionMap); SAMPLER(sampler_EmissionMap);
            CBUFFER_START(UnityPerMaterial)
                float4 _BaseMap_ST;
                half4 _BaseColor;
                half4 _EmissionColor;
            CBUFFER_END
            UNITY_INSTANCING_BUFFER_START(OfficeInstances)
                UNITY_DEFINE_INSTANCED_PROP(half4, _Tint)
            UNITY_INSTANCING_BUFFER_END(OfficeInstances)
            half3 _NightHemiSky, _NightHemiGround, _NightAmbient, _NightFill;
            float3 _NightInsideMin, _NightInsideMax;
            float _NightScreenCount;
            float4 _NightScreens[MAX_SCREENS];
            float4 _NightScreenDirs[MAX_SCREENS];
            float4 _NightScreenColors[MAX_SCREENS];
            float3 _NightScreenMin, _NightScreenMax;
            struct Attributes
            {
                float4 positionOS : POSITION;
                float3 normalOS : NORMAL;
                float2 uv : TEXCOORD0;
                half4 color : COLOR;
                UNITY_VERTEX_INPUT_INSTANCE_ID
            };
            struct Varyings
            {
                float4 positionCS : SV_POSITION;
                float3 positionWS : TEXCOORD0;
                float3 normalWS : TEXCOORD1;
                float2 uv : TEXCOORD2;
                half4 color : COLOR;
                UNITY_VERTEX_INPUT_INSTANCE_ID
                UNITY_VERTEX_OUTPUT_STEREO
            };
            Varyings Vert(Attributes input)
            {
                Varyings output;
                UNITY_SETUP_INSTANCE_ID(input);
                UNITY_INITIALIZE_VERTEX_OUTPUT_STEREO(output);
                UNITY_TRANSFER_INSTANCE_ID(input, output);
                output.positionWS = TransformObjectToWorld(input.positionOS.xyz);
                output.positionCS = TransformWorldToHClip(output.positionWS);
                output.normalWS = TransformObjectToWorldNormal(input.normalOS);
                output.uv = TRANSFORM_TEX(input.uv, _BaseMap);
                output.color = input.color;
                return output;
            }
            // The source's gradient map: 90/185/255 over thirds of dot*0.5+0.5.
            half Ramp(half dotNL)
            {
                half coordinate = dotNL * 0.5h + 0.5h;
                return coordinate < 0.3333h ? 0.353h : coordinate < 0.6667h ? 0.725h : 1.0h;
            }
            half Inside(float3 p)
            {
                float3 outside = max(_NightInsideMin - p, p - _NightInsideMax);
                return 1.0h - (half)smoothstep(0.0, 0.12, length(max(outside, 0.0)));
            }
            half3 Screens(float3 p, half3 n)
            {
                half3 sum = 0;
                if (any(p < _NightScreenMin) || any(p > _NightScreenMax)) return sum;
                for (int i = 0; i < MAX_SCREENS; i++)
                {
                    if (i >= (int)_NightScreenCount) break;
                    float3 d = _NightScreens[i].xyz - p;
                    float r = max(length(d), 0.001);
                    half k = 1.0h - (half)saturate(r / _NightScreens[i].w);
                    half front = 0.12h + 0.88h * (half)smoothstep(-0.1, 0.7, dot(-d / r, _NightScreenDirs[i].xyz));
                    sum += (half3)_NightScreenColors[i].rgb * (k * k * front * (0.35h + 0.65h * saturate(dot(n, (half3)(d / r)))));
                }
                return sum;
            }
            half4 Frag(Varyings input) : SV_Target
            {
                UNITY_SETUP_STEREO_EYE_INDEX_POST_VERTEX(input);
                UNITY_SETUP_INSTANCE_ID(input);
                half3 n = (half3)normalize(input.normalWS);
                half4 surface = SAMPLE_TEXTURE2D(_BaseMap, sampler_BaseMap, input.uv) * _BaseColor * input.color *
                    UNITY_ACCESS_INSTANCED_PROP(OfficeInstances, _Tint);
                Light moon = GetMainLight();
                half3 light = lerp(_NightHemiGround, _NightHemiSky, n.y * 0.5h + 0.5h) + _NightAmbient +
                    Inside(input.positionWS) * _NightFill * (0.65h + 0.35h * n.y) +
                    Screens(input.positionWS, n) +
                    (half3)moon.color * Ramp(dot(n, (half3)moon.direction));
                half3 emission = _EmissionColor.rgb * SAMPLE_TEXTURE2D(_EmissionMap, sampler_EmissionMap, input.uv).rgb;
                return half4(surface.rgb * light * INV_PI + emission, 1);
            }
            ENDHLSL
        }
    }
}
