Shader "DroidOffice/Terminal/Cells"
{
    Properties
    {
        _Cells("Cells", 2D) = "black" {}
        _Glyphs("Glyph metrics", 2D) = "black" {}
        _Atlas("Glyph atlas", 2D) = "white" {}
        _Grid("Grid", Vector) = (120,40,0,0)
        _MSDF("Multi-channel distance field", Float) = 0
    }
    SubShader
    {
        Tags { "RenderPipeline"="UniversalPipeline" "RenderType"="Opaque" "Queue"="Geometry" }
        Pass
        {
            Cull Back
            ZWrite On
            HLSLPROGRAM
            #pragma vertex Vert
            #pragma fragment Frag
            #pragma target 3.5
            #pragma multi_compile_instancing
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
            #include "Packages/com.unity.render-pipelines.core/ShaderLibrary/Color.hlsl"
            TEXTURE2D(_Cells); SAMPLER(sampler_Cells);
            TEXTURE2D(_Glyphs); SAMPLER(sampler_Glyphs);
            TEXTURE2D(_Atlas); SAMPLER(sampler_Atlas);
            CBUFFER_START(UnityPerMaterial)
                float4 _Grid;
                float _MSDF;
            CBUFFER_END
            struct Attributes { float4 positionOS : POSITION; float2 uv : TEXCOORD0; UNITY_VERTEX_INPUT_INSTANCE_ID };
            struct Varyings { float4 positionCS : SV_POSITION; float2 uv : TEXCOORD0; UNITY_VERTEX_OUTPUT_STEREO };
            Varyings Vert(Attributes input)
            {
                Varyings output;
                UNITY_SETUP_INSTANCE_ID(input);
                UNITY_INITIALIZE_VERTEX_OUTPUT_STEREO(output);
                output.positionCS = TransformObjectToHClip(input.positionOS.xyz);
                output.uv = input.uv;
                return output;
            }
            float Median(float3 value) { return max(min(value.r,value.g), min(max(value.r,value.g),value.b)); }
            half4 Frag(Varyings input) : SV_Target
            {
                UNITY_SETUP_STEREO_EYE_INDEX_POST_VERTEX(input);
                float2 position = float2(input.uv.x, 1-input.uv.y) * _Grid.xy;
                float2 cell = min(floor(position), _Grid.xy-1);
                float2 local = float2(frac(position.x), 1-frac(position.y));
                float2 dataUV = float2((cell.x*3+0.5)/(_Grid.x*3), (cell.y+0.5)/_Grid.y);
                float4 data = round(SAMPLE_TEXTURE2D_LOD(_Cells,sampler_Cells,dataUV,0)*255);
                uint id = (uint)(data.x+data.y*256);
                uint flags = (uint)data.z;
                float3 fg = SAMPLE_TEXTURE2D_LOD(_Cells,sampler_Cells,dataUV+float2(1/(_Grid.x*3),0),0).rgb;
                float3 bg = SAMPLE_TEXTURE2D_LOD(_Cells,sampler_Cells,dataUV+float2(2/(_Grid.x*3),0),0).rgb;
                if ((flags & 2u) != 0) { float3 swap = fg; fg = bg; bg = swap; }
                if ((flags & 4u) != 0) fg *= 0.65;
                float2 glyphUV = float2((id+0.5)/2048.0, 0.25);
                float4 rect = SAMPLE_TEXTURE2D_LOD(_Glyphs,sampler_Glyphs,glyphUV,0);
                float4 metrics = SAMPLE_TEXTURE2D_LOD(_Glyphs,sampler_Glyphs,glyphUV+float2(0,0.5),0);
                float2 glyphCoordinate = (local-metrics.xy)/max(metrics.zw,0.00001);
                float4 distanceTexel = SAMPLE_TEXTURE2D(_Atlas,sampler_Atlas,rect.xy+glyphCoordinate*rect.zw);
                float distance = _MSDF > 0.5 ? Median(distanceTexel.rgb) : distanceTexel.a;
                float edge = (flags & 1u) != 0 ? 0.44 : 0.5;
                float aa = max(fwidth(distance), 0.015);
                float coverage = smoothstep(edge-aa,edge+aa,distance);
                coverage *= step(0,glyphCoordinate.x)*step(0,glyphCoordinate.y)*step(glyphCoordinate.x,1)*step(glyphCoordinate.y,1);
                if (id == 0 || (flags & 64u) != 0) coverage = 0;
                if ((flags & 16u) != 0 && local.y < 0.08) coverage = 1;
                if ((flags & 32u) != 0 && abs(local.y-0.5) < 0.035) coverage = 1;
                return half4(lerp(SRGBToLinear(bg),SRGBToLinear(fg),coverage),1);
            }
            ENDHLSL
        }
    }
}
