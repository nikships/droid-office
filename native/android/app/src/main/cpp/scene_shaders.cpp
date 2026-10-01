// The GLSL in this file is ported from three.js r186 (src/renderers/shaders/ShaderLib and
// ShaderChunk) and from src/client/world/sky.ts, rooftop.ts. Function bodies keep three's names and
// wording so they can be compared line by line with the originals; lighting runs in world space
// instead of three's view space, which gives the same values because every term is a dot product or
// a length.
#include "scene_shaders.h"

#include "scene_uniforms.h"

namespace office::scene {

uint32_t ProgramKey::bits() const {
    uint32_t b = uint32_t(model) | uint32_t(fog) << 4;
    int i = 6;
    for (bool f :
         {multiview, linearOutput, sky, map, alphaMap, emissiveMap, gradientMap, alphaTest, opaque,
          premultipliedAlpha, doubleSided, backSide, shadows, flatShading, sizeAttenuation})
        b |= uint32_t(f) << i++;
    b |= uint32_t(sharpDepth) << i;
    b |= uint32_t(sharpOverlay) << (i + 2);
    return b;
}

namespace {

// What a key turns into once the flags that do not apply to its model are dropped.
struct Features {
    ShadeModel model;
    bool lit, depth, beam, dome, points, sprite;
    bool multiview, linearOutput;
    FogMode fog;
    bool haze;   // sky.ts HAZE replaces the linear fog
    bool skyLit; // sky.ts PARS/SURFACE/LIGHT
    bool map, alphaMap, emissiveMap, gradientMap, alphaTest, opaque, premultiplied;
    bool doubleSided, backSide, shadows, flatShading, sizeAttenuation;
    bool vertexColor;
    bool normal;      // world normal varying
    bool world;       // world position varying
    bool toEye;       // eye - world varying (three's vViewPosition, in world space)
    bool viewNormal;  // view-space normal varying (Standard's geometryRoughness is not rotation
                      // invariant)
    SharpDepth sharp; // screen layer: which world depth texture it samples
    bool overlay;     // screen layer: a surface drawn over the screens
};

Features features(const ProgramKey &k) {
    Features f{};
    f.model = k.model;
    const ShadeModel m = k.model;
    f.lit = m == ShadeModel::Toon || m == ShadeModel::Lambert || m == ShadeModel::Phong ||
            m == ShadeModel::Standard;
    f.depth = m == ShadeModel::Depth;
    f.beam = m == ShadeModel::Beam;
    f.dome = m == ShadeModel::SkyDome;
    f.points = m == ShadeModel::Points;
    f.sprite = m == ShadeModel::Sprite;
    const bool shaderMaterial = f.beam || f.dome;

    f.multiview = k.multiview && !f.depth;
    f.linearOutput = k.linearOutput;
    f.fog = (shaderMaterial || f.depth) ? FogMode::None : k.fog;
    f.haze = k.sky && f.fog == FogMode::Linear;
    f.skyLit = k.sky && f.lit;

    // three's shadow pass keeps a material's maps only when it alpha tests.
    const bool maps = !shaderMaterial && (!f.depth || k.alphaTest);
    f.map = maps && k.map;
    f.alphaMap = maps && k.alphaMap;
    f.emissiveMap = f.lit && k.emissiveMap;
    f.gradientMap = m == ShadeModel::Toon && k.gradientMap;
    f.alphaTest = maps && k.alphaTest;
    f.opaque = !shaderMaterial && !f.depth && k.opaque;
    // SpriteMaterial's fragment shader has no premultiplied_alpha_fragment.
    f.premultiplied = !shaderMaterial && !f.depth && !f.sprite && k.premultipliedAlpha;
    f.doubleSided = f.lit && k.doubleSided && !k.flatShading;
    f.backSide = f.lit && k.backSide;
    f.shadows = f.lit && k.shadows;
    f.flatShading = f.lit && k.flatShading;
    f.sizeAttenuation = k.sizeAttenuation;
    f.vertexColor = !shaderMaterial && !f.depth && !f.sprite;

    f.normal = (f.lit && !f.flatShading) || f.beam;
    f.world = f.lit;
    f.toEye = m == ShadeModel::Phong || m == ShadeModel::Standard || f.beam;
    f.viewNormal = m == ShadeModel::Standard && !f.flatShading;
    f.sharp = (shaderMaterial || f.depth) ? SharpDepth::None : k.sharpDepth;
    f.overlay = f.sharp != SharpDepth::None && k.sharpOverlay;
    return f;
}

const std::string kMaxHemiS = std::to_string(kMaxHemi);
const std::string kMaxDirS = std::to_string(kMaxDir);
const std::string kMaxPointS = std::to_string(kMaxPoint);
const std::string kMaxLampsS = std::to_string(kMaxLamps);
const std::string kMaxScreensS = std::to_string(kMaxScreens);

// std140 blocks, member for member the structs in scene_uniforms.h. Explicit highp so the vertex
// and fragment declarations match whatever the stage's default precision is.
std::string viewBlock() {
    return "layout(std140) uniform View {\n"
           "  highp mat4 viewProj[2];\n"
           "  highp mat4 view[2];\n"
           "  highp mat4 proj[2];\n"
           "  highp vec4 cameraPos[2];\n"
           "  highp vec4 viewport;\n"
           "} uView;\n";
}

std::string frameBlock() {
    return "layout(std140) uniform Frame {\n"
           "  highp vec4 fogColor;\n"
           "  highp vec4 fogParams;\n"
           "  highp vec4 ambient;\n"
           "  highp ivec4 counts;\n"
           "  highp vec4 hemiSky[" +
           kMaxHemiS +
           "];\n"
           "  highp vec4 hemiGround[" +
           kMaxHemiS +
           "];\n"
           "  highp vec4 hemiDir[" +
           kMaxHemiS +
           "];\n"
           "  highp vec4 dirColor[" +
           kMaxDirS +
           "];\n"
           "  highp vec4 dirDir[" +
           kMaxDirS +
           "];\n"
           "  highp vec4 pointPos[" +
           kMaxPointS +
           "];\n"
           "  highp vec4 pointColor[" +
           kMaxPointS +
           "];\n"
           "  highp mat4 shadowMatrix;\n"
           "  highp vec4 shadowParams;\n"
           "  highp vec4 shadowMapSize;\n"
           "} uFrame;\n";
}

std::string skyBlock() {
    return "layout(std140) uniform Sky {\n"
           "  highp vec4 flags;\n"
           "  highp vec4 misc;\n"
           "  highp vec4 haze;\n"
           "  highp vec4 office;\n"
           "  highp vec4 garage;\n"
           "  highp vec4 officeMin;\n"
           "  highp vec4 officeMax;\n"
           "  highp vec4 garageBox;\n"
           "  highp vec4 garageY;\n"
           "  highp ivec4 counts;\n"
           "  highp vec4 lampMin;\n"
           "  highp vec4 lampMax;\n"
           "  highp vec4 screenMin;\n"
           "  highp vec4 screenMax;\n"
           "  highp vec4 lamps[" +
           kMaxLampsS +
           "];\n"
           "  highp vec4 lampColors[" +
           kMaxLampsS +
           "];\n"
           "  highp vec4 screens[" +
           kMaxScreensS +
           "];\n"
           "  highp vec4 screenDirs[" +
           kMaxScreensS +
           "];\n"
           "  highp vec4 screenColors[" +
           kMaxScreensS +
           "];\n"
           "} uSky;\n";
}

const char *kAttributes = "layout(location = 0) in vec3 aPosition;\n"
                          "layout(location = 1) in vec3 aNormal;\n"
                          "layout(location = 2) in vec2 aUv;\n"
                          "layout(location = 3) in vec4 aColor;\n"
                          "layout(location = 4) in vec4 aInstance0;\n"
                          "layout(location = 5) in vec4 aInstance1;\n"
                          "layout(location = 6) in vec4 aInstance2;\n"
                          "layout(location = 7) in vec3 aInstanceColor;\n";

// three's <common>, the parts these programs use.
const char *kCommon = R"(#define PI 3.141592653589793
#define PI2 6.283185307179586
#define RECIPROCAL_PI 0.3183098861837907
#define EPSILON 1e-6
#define saturate( a ) clamp( a, 0.0, 1.0 )
float pow2( const in float x ) { return x*x; }
vec3 pow2( const in vec3 x ) { return x*x; }
float pow4( const in float x ) { float x2 = x*x; return x2*x2; }
struct IncidentLight {
	vec3 color;
	vec3 direction;
};
struct ReflectedLight {
	vec3 directDiffuse;
	vec3 directSpecular;
	vec3 indirectDiffuse;
	vec3 indirectSpecular;
};
vec3 BRDF_Lambert( const in vec3 diffuseColor ) {
	return RECIPROCAL_PI * diffuseColor;
}
vec3 F_Schlick( const in vec3 f0, const in float f90, const in float dotVH ) {
	float fresnel = exp2( ( - 5.55473 * dotVH - 6.98316 ) * dotVH );
	return f0 * ( 1.0 - fresnel ) + ( f90 * fresnel );
}
// Full-resolution pixels between neighbouring invocations, (1, 1) unless foveated.
// GL_QCOM_texture_foveated issue 4: in a scaled bin gl_FragCoord is scaled to full-resolution
// positions while dFdx and dFdy get no corrective scaling. Derivative-based shading divides by
// this, so it matches across bins of different density instead of changing at their edges.
vec2 foveatedStep() {
	return max( abs( vec2( dFdx( gl_FragCoord.x ), dFdy( gl_FragCoord.y ) ) ), vec2( 1.0 ) );
}
)";

// three's colorspace_pars_fragment.
const char *kColorspace = R"(vec4 sRGBTransferEOTF( in vec4 value ) {
	return vec4( mix( pow( value.rgb * 0.9478672986 + vec3( 0.0521327014 ), vec3( 2.4 ) ), value.rgb * 0.0773993808, vec3( lessThanEqual( value.rgb, vec3( 0.04045 ) ) ) ), value.a );
}
vec4 sRGBTransferOETF( in vec4 value ) {
	return vec4( mix( pow( value.rgb, vec3( 0.41666 ) ) * 1.055 - vec3( 0.055 ), value.rgb * 12.92, vec3( lessThanEqual( value.rgb, vec3( 0.0031308 ) ) ) ), value.a );
}
)";

// three's lights_pars_begin getDistanceAttenuation.
const char *kDistanceAttenuation =
    R"(float getDistanceAttenuation( const in float lightDistance, const in float cutoffDistance, const in float decayExponent ) {
	float distanceFalloff = 1.0 / max( pow( lightDistance, decayExponent ), 0.01 );
	if ( cutoffDistance > 0.0 ) {
		distanceFalloff *= pow2( saturate( 1.0 - pow4( lightDistance / cutoffDistance ) ) );
	}
	return distanceFalloff;
}
)";

// three's shadowmap_pars_fragment, SHADOWMAP_TYPE_PCF, directional.
const char *kShadow = R"(float interleavedGradientNoise( vec2 position ) {
	return fract( 52.9829189 * fract( dot( position, vec2( 0.06711056, 0.00583715 ) ) ) );
}
vec2 vogelDiskSample( int sampleIndex, int samplesCount, float phi ) {
	const float goldenAngle = 2.399963229728653;
	float r = sqrt( ( float( sampleIndex ) + 0.5 ) / float( samplesCount ) );
	float theta = float( sampleIndex ) * goldenAngle + phi;
	return vec2( cos( theta ), sin( theta ) ) * r;
}
float getShadow( vec2 shadowMapSize, float shadowIntensity, float shadowBias, float shadowRadius, vec4 shadowCoord ) {
	float shadow = 1.0;
	shadowCoord.xyz /= shadowCoord.w;
	shadowCoord.z += shadowBias;
	bool inFrustum = shadowCoord.x >= 0.0 && shadowCoord.x <= 1.0 && shadowCoord.y >= 0.0 && shadowCoord.y <= 1.0;
	bool frustumTest = inFrustum && shadowCoord.z <= 1.0;
	if ( frustumTest ) {
		vec2 texelSize = vec2( 1.0 ) / shadowMapSize;
		float radius = shadowRadius * texelSize.x;
		float phi = interleavedGradientNoise( gl_FragCoord.xy ) * PI2;
		shadow = (
			texture( uShadowMap, vec3( shadowCoord.xy + vogelDiskSample( 0, 5, phi ) * radius, shadowCoord.z ) ) +
			texture( uShadowMap, vec3( shadowCoord.xy + vogelDiskSample( 1, 5, phi ) * radius, shadowCoord.z ) ) +
			texture( uShadowMap, vec3( shadowCoord.xy + vogelDiskSample( 2, 5, phi ) * radius, shadowCoord.z ) ) +
			texture( uShadowMap, vec3( shadowCoord.xy + vogelDiskSample( 3, 5, phi ) * radius, shadowCoord.z ) ) +
			texture( uShadowMap, vec3( shadowCoord.xy + vogelDiskSample( 4, 5, phi ) * radius, shadowCoord.z ) )
		) * 0.2;
	}
	return mix( 1.0, shadow, shadowIntensity );
}
)";

// sky.ts PARS, with its uniforms and constants read from the Sky block.
std::string skyPars() {
    return R"(#define skyOn uSky.flags.x
#define skyInside uSky.flags.y
#define skyWet uSky.flags.z
#define skySnow uSky.flags.w
#define skyDrop uSky.misc.x
#define skyOffice uSky.office.rgb
#define skyGarage uSky.garage.rgb
#define skyLampCount uSky.counts.x
#define skyLampMin uSky.lampMin.xyz
#define skyLampMax uSky.lampMax.xyz
#define skyScreenCount uSky.counts.y
#define skyScreenMin uSky.screenMin.xyz
#define skyScreenMax uSky.screenMax.xyz

// Inside the office's walls (and up through its open top).
float skyInOffice( vec3 p ) {
  vec3 d = max( uSky.officeMin.xyz - p, p - uSky.officeMax.xyz );
  return 1.0 - smoothstep( 0.0, 0.12, length( max( d, 0.0 ) ) );
}

// Under the bottom floor: walled at the back and on the west side, open to the street on the south and east.
float skyInGarage( vec3 p ) {
  if ( p.x < uSky.garageBox.x || p.z < uSky.garageBox.y || p.y + skyDrop < uSky.garageY.x || p.y + skyDrop > uSky.garageY.y ) return 0.0;
  return 1.0 - smoothstep( 0.0, 3.0, length( max( p.xz - uSky.garageBox.zw, 0.0 ) ) );
}

vec3 skyLampsAt( vec3 p, vec3 n ) {
  vec3 sum = vec3( 0.0 );
  if ( any( lessThan( p, skyLampMin ) ) || any( greaterThan( p, skyLampMax ) ) ) return sum;
  for ( int i = 0; i < )" +
           kMaxLampsS + R"(; i ++ ) {
    if ( i >= skyLampCount ) break;
    vec3 d = uSky.lamps[ i ].xyz - p;
    float r = length( d );
    float k = 1.0 - clamp( r / uSky.lamps[ i ].w, 0.0, 1.0 );
    sum += uSky.lampColors[ i ].rgb * k * k * ( 0.3 + 0.7 * max( dot( n, d / max( r, 0.001 ) ), 0.0 ) );
  }
  return sum;
}

// A laptop screen throws its light forward, and a little all round from the glow off the lid.
vec3 skyScreensAt( vec3 p, vec3 n ) {
  vec3 sum = vec3( 0.0 );
  if ( any( lessThan( p, skyScreenMin ) ) || any( greaterThan( p, skyScreenMax ) ) ) return sum;
  for ( int i = 0; i < )" +
           kMaxScreensS + R"(; i ++ ) {
    if ( i >= skyScreenCount ) break;
    vec3 d = uSky.screens[ i ].xyz - p;
    float r = max( length( d ), 0.001 );
    float k = 1.0 - clamp( r / uSky.screens[ i ].w, 0.0, 1.0 );
    float front = 0.12 + 0.88 * smoothstep( -0.1, 0.7, dot( -d / r, uSky.screenDirs[ i ].xyz ) );
    sum += uSky.screenColors[ i ].rgb * k * k * front * ( 0.35 + 0.65 * max( dot( n, d / r ), 0.0 ) );
  }
  return sum;
}
)";
}

// sky.ts SURFACE. `normal` is already the world normal, which is what `normal * viewMatrix` gives.
const char *kSkySurface = R"(	vec3 skyN = normal;
	float skyIndoor = skyOn * skyInside * skyInOffice( vSkyWorld );
	float skyGar = skyOn * skyInside * skyInGarage( vSkyWorld );
	float skyUp = skyOn * ( 1.0 - max( skyIndoor, skyGar ) ) * smoothstep( 0.45, 0.85, skyN.y );
	material.diffuseColor *= 1.0 - 0.38 * skyWet * skyUp;
	material.diffuseColor = mix( material.diffuseColor, vec3( 0.93, 0.96, 1.0 ), skySnow * skyUp );
)";

// sky.ts LIGHT.
const char *kSkyLight = R"(	if ( skyOn > 0.0 ) {
		vec3 skyLight = skyIndoor * skyOffice * ( 0.65 + 0.35 * skyN.y ) + skyScreensAt( vSkyWorld, skyN );
		// The lamps and the garage light only what's outside the office, so indoors skips their loop outright.
		if ( skyIndoor < 1.0 ) skyLight += ( 1.0 - skyIndoor ) * ( skyGar * skyGarage + skyLampsAt( vSkyWorld, skyN ) );
		reflectedLight.indirectDiffuse += skyLight * BRDF_Lambert( material.diffuseColor );
	}
)";

// Per-model material structs and render equations (three's lights_*_pars_fragment).
const char *kToon = R"(struct ToonMaterial {
	vec3 diffuseColor;
};
vec3 getGradientIrradiance( vec3 normal, vec3 lightDirection ) {
	float dotNL = dot( normal, lightDirection );
	vec2 coord = vec2( dotNL * 0.5 + 0.5, 0.0 );
#ifdef USE_GRADIENTMAP
	return vec3( texture( uGradientMap, coord ).r );
#else
	vec2 fovStep = foveatedStep();
	vec2 fw = ( abs( dFdx( coord ) ) / fovStep.x + abs( dFdy( coord ) ) / fovStep.y ) * 0.5;
	return mix( vec3( 0.7 ), vec3( 1.0 ), smoothstep( 0.7 - fw.x, 0.7 + fw.x, coord.x ) );
#endif
}
void RE_Direct( const in IncidentLight directLight, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in ToonMaterial material, inout ReflectedLight reflectedLight ) {
	vec3 irradiance = getGradientIrradiance( geometryNormal, directLight.direction ) * directLight.color;
	reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
}
void RE_IndirectDiffuse( const in vec3 irradiance, const in ToonMaterial material, inout ReflectedLight reflectedLight ) {
	reflectedLight.indirectDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
}
)";

const char *kLambert = R"(struct LambertMaterial {
	vec3 diffuseColor;
	float specularStrength;
};
void RE_Direct( const in IncidentLight directLight, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in LambertMaterial material, inout ReflectedLight reflectedLight ) {
	float dotNL = saturate( dot( geometryNormal, directLight.direction ) );
	vec3 irradiance = dotNL * directLight.color;
	reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
}
void RE_IndirectDiffuse( const in vec3 irradiance, const in LambertMaterial material, inout ReflectedLight reflectedLight ) {
	reflectedLight.indirectDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
}
)";

const char *kPhong = R"(struct BlinnPhongMaterial {
	vec3 diffuseColor;
	vec3 specularColor;
	float specularShininess;
	float specularStrength;
};
float G_BlinnPhong_Implicit( /* const in float dotNL, const in float dotNV */ ) {
	return 0.25;
}
float D_BlinnPhong( const in float shininess, const in float dotNH ) {
	return RECIPROCAL_PI * ( shininess * 0.5 + 1.0 ) * pow( dotNH, shininess );
}
vec3 BRDF_BlinnPhong( const in vec3 lightDir, const in vec3 viewDir, const in vec3 normal, const in vec3 specularColor, const in float shininess ) {
	vec3 halfDir = normalize( lightDir + viewDir );
	float dotNH = saturate( dot( normal, halfDir ) );
	float dotVH = saturate( dot( viewDir, halfDir ) );
	vec3 F = F_Schlick( specularColor, 1.0, dotVH );
	float G = G_BlinnPhong_Implicit( /* dotNL, dotNV */ );
	float D = D_BlinnPhong( shininess, dotNH );
	return F * ( G * D );
}
void RE_Direct( const in IncidentLight directLight, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in BlinnPhongMaterial material, inout ReflectedLight reflectedLight ) {
	float dotNL = saturate( dot( geometryNormal, directLight.direction ) );
	vec3 irradiance = dotNL * directLight.color;
	reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
	reflectedLight.directSpecular += irradiance * BRDF_BlinnPhong( directLight.direction, geometryViewDir, geometryNormal, material.specularColor, material.specularShininess ) * material.specularStrength;
}
void RE_IndirectDiffuse( const in vec3 irradiance, const in BlinnPhongMaterial material, inout ReflectedLight reflectedLight ) {
	reflectedLight.indirectDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
}
)";

// MeshStandardMaterial without IOR, clearcoat, sheen, iridescence, anisotropy or an environment
// map. r186 reads `dfg` from its DFG lookup texture; this uses the analytic DFGApprox of r150
// instead (Karis, "Physically Based Shading on Mobile"), so no LUT has to be uploaded.
const char *kStandard = R"(struct PhysicalMaterial {
	vec3 diffuseColor;
	vec3 diffuseContribution;
	vec3 specularColor;
	vec3 specularColorBlended;
	float roughness;
	float metalness;
	float specularF90;
	vec2 dfg;
	vec3 multiScatteringCompensation;
};
vec2 DFGApprox( const in vec3 normal, const in vec3 viewDir, const in float roughness ) {
	float dotNV = saturate( dot( normal, viewDir ) );
	const vec4 c0 = vec4( - 1, - 0.0275, - 0.572, 0.022 );
	const vec4 c1 = vec4( 1, 0.0425, 1.04, - 0.04 );
	vec4 r = roughness * c0 + c1;
	float a004 = min( r.x * r.x, exp2( - 9.28 * dotNV ) ) * r.x + r.y;
	vec2 fab = vec2( - 1.04, 1.04 ) * a004 + r.zw;
	return fab;
}
float V_GGX_SmithCorrelated( const in float alpha, const in float dotNL, const in float dotNV ) {
	float a2 = pow2( alpha );
	float gv = dotNL * sqrt( a2 + ( 1.0 - a2 ) * pow2( dotNV ) );
	float gl = dotNV * sqrt( a2 + ( 1.0 - a2 ) * pow2( dotNL ) );
	return 0.5 / max( gv + gl, EPSILON );
}
float D_GGX( const in float alpha, const in float dotNH ) {
	float a2 = pow2( alpha );
	float denom = pow2( dotNH ) * ( a2 - 1.0 ) + 1.0;
	return RECIPROCAL_PI * a2 / pow2( denom );
}
vec3 BRDF_GGX( const in vec3 lightDir, const in vec3 viewDir, const in vec3 normal, const in PhysicalMaterial material ) {
	vec3 f0 = material.specularColorBlended;
	float f90 = material.specularF90;
	float roughness = material.roughness;
	float alpha = pow2( roughness );
	vec3 halfDir = normalize( lightDir + viewDir );
	float dotNL = saturate( dot( normal, lightDir ) );
	float dotNV = saturate( dot( normal, viewDir ) );
	float dotNH = saturate( dot( normal, halfDir ) );
	float dotVH = saturate( dot( viewDir, halfDir ) );
	vec3 F = F_Schlick( f0, f90, dotVH );
	float V = V_GGX_SmithCorrelated( alpha, dotNL, dotNV );
	float D = D_GGX( alpha, dotNH );
	return F * ( V * D );
}
void computeMultiscattering( const in vec2 fab, const in vec3 specularColor, const in float specularF90, inout vec3 singleScatter, inout vec3 multiScatter ) {
	vec3 Fr = specularColor;
	vec3 FssEss = Fr * fab.x + specularF90 * fab.y;
	float Ess = fab.x + fab.y;
	float Ems = 1.0 - Ess;
	vec3 Favg = Fr + ( 1.0 - Fr ) * 0.047619; // 1/21
	vec3 Fms = FssEss * Favg / ( 1.0 - Ems * Favg );
	singleScatter += FssEss;
	multiScatter += Fms * Ems;
}
void RE_Direct( const in IncidentLight directLight, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
	float dotNL = saturate( dot( geometryNormal, directLight.direction ) );
	vec3 irradiance = dotNL * directLight.color;
	vec3 specularBRDF = BRDF_GGX( directLight.direction, geometryViewDir, geometryNormal, material );
	reflectedLight.directSpecular += irradiance * specularBRDF * material.multiScatteringCompensation;
	vec3 halfDir = normalize( directLight.direction + geometryViewDir );
	float dotVH = saturate( dot( geometryViewDir, halfDir ) );
	vec3 F = F_Schlick( material.specularColor, material.specularF90, dotVH );
	reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F );
}
void RE_IndirectDiffuse( const in vec3 irradiance, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
	vec3 singleScattering = vec3( 0.0 );
	vec3 multiScattering = vec3( 0.0 );
	computeMultiscattering( material.dfg, material.specularColor, material.specularF90, singleScattering, multiScattering );
	vec3 diffuse = irradiance * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - singleScattering - multiScattering );
	reflectedLight.indirectDiffuse += diffuse;
}
)";

// Builds one shader stage line by line.
struct Src {
    std::string s;
    Src &operator<<(const std::string &t) {
        s += t;
        return *this;
    }
    Src &operator<<(const char *t) {
        s += t;
        return *this;
    }
};

void header(Src &o, bool multiviewVertex) {
    o << "#version 300 es\n";
    if (multiviewVertex)
        o << "#extension GL_OVR_multiview2 : require\nlayout(num_views = 2) in;\n";
}

// ---- Vertex stage -------------------------------------------------------------------------------

std::string vertexShader(const Features &f) {
    Src o;
    header(o, f.multiview);
    o << "precision highp float;\nprecision highp int;\n";
    if (!f.depth)
        o << viewBlock();
    if (f.shadows)
        o << frameBlock();
    o << kAttributes;
    o << "uniform mat4 uModel;\n";
    if (f.depth)
        o << "uniform mat4 uLightViewProj;\n";
    if (f.normal || f.shadows)
        o << "uniform mat3 uNormalMatrix;\n";
    if (f.map)
        o << "uniform mat3 uMapTransform;\n";
    if (f.alphaMap)
        o << "uniform mat3 uAlphaMapTransform;\n";
    if (f.emissiveMap)
        o << "uniform mat3 uEmissiveMapTransform;\n";
    if (f.points)
        o << "uniform float uPointSize;\nuniform int uPointQuad;\n";
    if (f.sprite)
        o << "uniform vec2 uSpriteCenter;\nuniform float uSpriteRotation;\n";

    // Varyings, in the same order as the fragment stage declares them.
    const bool uvMaps = !f.points;
    if (f.map && uvMaps)
        o << "out vec2 vMapUv;\n";
    if (f.alphaMap && uvMaps)
        o << "out vec2 vAlphaMapUv;\n";
    if (f.emissiveMap)
        o << "out vec2 vEmissiveMapUv;\n";
    if (f.vertexColor)
        o << "out vec4 vColor;\n";
    if (f.world)
        o << "out vec3 vSkyWorld;\n";
    if (f.normal)
        o << "out vec3 vNormal;\n";
    if (f.viewNormal)
        o << "out vec3 vViewNormal;\n";
    if (f.toEye)
        o << "out vec3 vToEye;\n";
    if (f.fog != FogMode::None)
        o << "out float vFogDepth;\n";
    if (f.haze)
        o << "out vec2 vSkyFog;\n";
    if (f.shadows)
        o << "out vec4 vShadowCoord;\n";
    if (f.beam)
        o << "out float vAlong;\n";
    if (f.dome)
        o << "out vec3 vDir;\n";
    if (f.points)
        o << "out vec2 vPointCoord;\n";
    if (f.sharp != SharpDepth::None)
        o << "out float vSharpDist;\nflat out vec2 vSharpProj;\nflat out int vSharpView;\n";

    o << "void main() {\n";
    if (!f.depth)
        o << (f.multiview ? "\tint viewIndex = int( gl_ViewID_OVR );\n" : "\tint viewIndex = 0;\n");
    if (f.map && uvMaps)
        o << "\tvMapUv = ( uMapTransform * vec3( aUv, 1 ) ).xy;\n";
    if (f.alphaMap && uvMaps)
        o << "\tvAlphaMapUv = ( uAlphaMapTransform * vec3( aUv, 1 ) ).xy;\n";
    if (f.emissiveMap)
        o << "\tvEmissiveMapUv = ( uEmissiveMapTransform * vec3( aUv, 1 ) ).xy;\n";
    if (f.vertexColor)
        o << "\tvColor = aColor * vec4( aInstanceColor, 1.0 );\n";

    if (f.sprite) {
        // three's sprite.glsl.js vertex stage.
        o << "\tvec4 mvPosition = uView.view[ viewIndex ] * uModel[ 3 ];\n"
             "\tvec2 scale = vec2( length( uModel[ 0 ].xyz ), length( uModel[ 1 ].xyz ) );\n";
        if (!f.sizeAttenuation)
            o << "\tscale *= - mvPosition.z;\n";
        o << "\tvec2 alignedPosition = ( aPosition.xy - ( uSpriteCenter - vec2( 0.5 ) ) ) * "
             "scale;\n"
             "\tvec2 rotatedPosition;\n"
             "\trotatedPosition.x = cos( uSpriteRotation ) * alignedPosition.x - sin( "
             "uSpriteRotation ) * alignedPosition.y;\n"
             "\trotatedPosition.y = sin( uSpriteRotation ) * alignedPosition.x + cos( "
             "uSpriteRotation ) * alignedPosition.y;\n"
             "\tmvPosition.xy += rotatedPosition;\n"
             "\tgl_Position = uView.proj[ viewIndex ] * mvPosition;\n";
    } else {
        o << "\tvec4 instancePosition = vec4( aPosition, 1.0 );\n"
             "\tvec4 worldPosition = uModel * vec4( dot( aInstance0, instancePosition ), dot( "
             "aInstance1, instancePosition ), dot( aInstance2, instancePosition ), 1.0 );\n";
        if (f.depth) {
            o << "\tgl_Position = uLightViewProj * worldPosition;\n";
        } else {
            o << "\tvec4 mvPosition = uView.view[ viewIndex ] * worldPosition;\n"
                 "\tgl_Position = uView.viewProj[ viewIndex ] * worldPosition;\n";
        }
    }

    if (f.normal || f.shadows) {
        // three's defaultnormal_vertex with USE_INSTANCING; im's columns are those of the
        // instance's 3x3.
        o << "\tmat3 im = mat3( aInstance0.x, aInstance1.x, aInstance2.x, aInstance0.y, "
             "aInstance1.y, aInstance2.y, aInstance0.z, aInstance1.z, aInstance2.z );\n"
             "\tvec3 transformedNormal = aNormal;\n"
             "\ttransformedNormal /= vec3( dot( im[ 0 ], im[ 0 ] ), dot( im[ 1 ], im[ 1 ] ), dot( "
             "im[ 2 ], im[ 2 ] ) );\n"
             "\ttransformedNormal = im * transformedNormal;\n"
             "\ttransformedNormal = uNormalMatrix * transformedNormal;\n";
        if (f.backSide)
            o << "\ttransformedNormal = - transformedNormal;\n";
    }
    if (f.normal)
        o << "\tvNormal = normalize( transformedNormal );\n";
    if (f.viewNormal)
        o << "\tvViewNormal = normalize( mat3( uView.view[ viewIndex ] ) * transformedNormal );\n";
    if (f.world)
        o << "\tvSkyWorld = worldPosition.xyz;\n";
    // rooftop.ts normalizes its vView per vertex; three's vViewPosition is interpolated as it is.
    if (f.toEye)
        o << (f.beam ? "\tvToEye = normalize( uView.cameraPos[ viewIndex ].xyz - worldPosition.xyz "
                       ");\n"
                     : "\tvToEye = uView.cameraPos[ viewIndex ].xyz - worldPosition.xyz;\n");
    if (f.beam)
        o << "\tvAlong = aUv.y;\n";
    if (f.dome)
        o << "\tvDir = aPosition;\n";
    if (f.points) {
        o << "\tfloat pointSize = uPointSize;\n";
        if (f.sizeAttenuation)
            o << "\tpointSize *= ( uView.viewport.y / - mvPosition.z );\n";
        // A point is drawn as the square GL would rasterize for it, a quad from one instance per
        // point. GL_QCOM_texture_foveated issue 4: gl_PointSize gets "no corrective scaling" in a
        // foveated scaled bin, so GL points change size and drop out from bin to bin.
        // https://registry.khronos.org/OpenGL/extensions/QCOM/QCOM_texture_foveated.txt
        // uPointQuad 0 (indexed points) keeps GL points; vPointCoord.x < 0 then selects
        // gl_PointCoord. Half the size in NDC is size / height in pixels vertically; x follows
        // the projection's aspect, which is the eye image's for square pixels.
        o << "\tgl_PointSize = pointSize;\n"
             "\tvPointCoord = vec2( - 1.0 );\n"
             "\tif ( uPointQuad != 0 ) {\n"
             "\t\tvec2 corner = vec2( float( gl_VertexID & 1 ), float( ( gl_VertexID >> 1 ) & 1 "
             ") ) * 2.0 - 1.0;\n"
             "\t\tfloat halfNdc = max( pointSize, 1.0 ) / uView.viewport.x;\n"
             "\t\tgl_Position.xy += corner * vec2( uView.proj[ viewIndex ][ 0 ][ 0 ] / "
             "uView.proj[ viewIndex ][ 1 ][ 1 ], 1.0 ) * ( halfNdc * gl_Position.w );\n"
             "\t\tvPointCoord = vec2( corner.x, - corner.y ) * 0.5 + 0.5;\n"
             "\t}\n";
    }
    if (f.shadows) {
        // three's shadowmap_vertex: offset along the world normal, before any gl_FrontFacing flip.
        o << "\tvec3 shadowWorldNormal = normalize( transformedNormal );\n"
             "\tvShadowCoord = uFrame.shadowMatrix * ( worldPosition + vec4( shadowWorldNormal * "
             "uFrame.shadowParams.y, 0 ) );\n";
    }
    if (f.fog != FogMode::None)
        o << "\tvFogDepth = - mvPosition.z;\n";
    // sky.ts HAZE_VERTEX: the view matrix undone, from the camera, which is the world y.
    if (f.haze)
        o << "\tvSkyFog = vec2( dot( uView.view[ viewIndex ][ 1 ].xyz, mvPosition.xyz ) + "
             "uView.cameraPos[ viewIndex ].y, uView.cameraPos[ viewIndex ].y );\n";
    if (f.sharp != SharpDepth::None) {
        // The eye distance (view-space z is affine, so interpolation is exact) and the projection
        // terms that turn a window depth of this view back into that distance.
        o << "\tvSharpDist = - mvPosition.z;\n"
             "\tvSharpProj = vec2( uView.proj[ viewIndex ][ 2 ][ 2 ], uView.proj[ viewIndex ][ 3 "
             "][ 2 ] );\n"
             "\tvSharpView = viewIndex;\n";
    }
    o << "}\n";
    return o.s;
}

// The screen layer's world depth test. uSharpRect maps this pass's viewport ([0,1]^2) into the
// world depth texture; uSharpParams: xy 1 / viewport size, z depth slack in world texels, w 1 -
// fade; uSharpBias: x metres, y largest slope term in metres, z array layer (single view), w metres
// per metre.
std::string sharpPars(const Features &f) {
    const bool array = f.sharp == SharpDepth::Array;
    std::string s = "in float vSharpDist;\nflat in vec2 vSharpProj;\nflat in int vSharpView;\n";
    s += array ? "uniform highp sampler2DArray uSharpDepth;\n"
               : "uniform highp sampler2D uSharpDepth;\n";
    s += "uniform vec4 uSharpRect;\nuniform vec4 uSharpParams;\nuniform vec4 uSharpBias;\n"
         "// Eye distance of the nearest surface the world pass left in its depth texture here.\n"
         "float sharpWorldDistance() {\n"
         "\tvec2 uv = uSharpRect.xy + gl_FragCoord.xy * uSharpParams.xy * uSharpRect.zw;\n";
    s += array ? "\tfloat depth = texture( uSharpDepth, vec3( uv, float( vSharpView ) + "
                 "uSharpBias.z ) ).r;\n"
               : "\tfloat depth = texture( uSharpDepth, uv ).r;\n";
    s += "\treturn vSharpProj.y / ( depth * 2.0 - 1.0 + vSharpProj.x );\n"
         "}\n";
    return s;
}

// The start of the screen layer's main(), in uniform control flow: whether the world depth hides
// this screen fragment, or does not show this overlay fragment in front. A screen's own world draw
// lies at its depth, sampled at a world texel that may be a few high-resolution pixels away (lower
// resolution, MSAA resolve, foveated periphery), so the slack grows with the depth slope across
// that many texels, capped so it never reaches far enough to show a screen through a wall.
void sharpTest(Src &o, const Features &f) {
    if (f.overlay) {
        o << "\tbool sharpHidden = vSharpDist > sharpWorldDistance() - uSharpBias.x;\n";
        return;
    }
    o << "\tfloat sharpSlope = fwidth( vSharpDist );\n"
         "\tvec2 sharpTexels = vec2( textureSize( uSharpDepth, 0 ).xy ) * uSharpRect.zw * "
         "uSharpParams.xy;\n"
         "\tfloat sharpPixelsPerTexel = 1.0 / max( min( sharpTexels.x, sharpTexels.y ), 1e-6 );\n"
         "\tfloat sharpSlack = uSharpBias.x + uSharpBias.w * vSharpDist + min( sharpSlope * "
         "sharpPixelsPerTexel * uSharpParams.z, uSharpBias.y );\n"
         "\tbool sharpHidden = sharpWorldDistance() < vSharpDist - sharpSlack;\n";
}

// The end of the screen layer's main(): the discard (after every texture read, so implicit
// derivatives stay defined across the quad), then premultiplied output, faded to black as the world
// is.
void sharpOutput(Src &o, const Features &f) {
    o << "\tif ( sharpHidden ) discard;\n";
    if (f.overlay) {
        if (!f.premultiplied)
            o << "\tpc_fragColor.rgb *= pc_fragColor.a;\n";
        o << "\tpc_fragColor.rgb *= uSharpParams.w;\n";
    } else {
        o << "\tpc_fragColor = vec4( pc_fragColor.rgb * uSharpParams.w, 1.0 );\n";
    }
}

// ---- Fragment stage -----------------------------------------------------------------------------

// Fog, the color space and premultiplication: three's order, then back to linear for an sRGB
// target.
void colorPipeline(Src &o, const Features &f) {
    const bool fog = f.fog != FogMode::None;
    // three encodes (linearToOutputTexel) before fog. For an sRGB target the encode and the decode
    // cancel exactly unless fog is mixed in between, so they only run then.
    const bool encode = !f.beam && (!f.linearOutput || fog);
    if (encode)
        o << "\tpc_fragColor = sRGBTransferOETF( pc_fragColor );\n";
    if (f.haze) {
        o << "\tfloat skyReach = 1.0 + max( max( vSkyFog.y, vSkyFog.x ) - uSky.misc.y - "
             "uSky.misc.z, 0.0 ) / uSky.misc.w;\n"
             "\tfloat fogFactor = max( smoothstep( uFrame.fogParams.x, uFrame.fogParams.y, "
             "vFogDepth / skyReach ), smoothstep( uSky.haze.x * 0.45, uSky.haze.x, vFogDepth ) );\n"
             "\tpc_fragColor.rgb = mix( pc_fragColor.rgb, uFrame.fogColor.rgb, fogFactor );\n";
    } else if (f.fog == FogMode::Linear) {
        o << "\tfloat fogFactor = smoothstep( uFrame.fogParams.x, uFrame.fogParams.y, vFogDepth "
             ");\n"
             "\tpc_fragColor.rgb = mix( pc_fragColor.rgb, uFrame.fogColor.rgb, fogFactor );\n";
    } else if (f.fog == FogMode::Exp2) {
        o << "\tfloat fogFactor = 1.0 - exp( - uFrame.fogParams.z * uFrame.fogParams.z * vFogDepth "
             "* vFogDepth );\n"
             "\tpc_fragColor.rgb = mix( pc_fragColor.rgb, uFrame.fogColor.rgb, fogFactor );\n";
    }
    if (f.linearOutput && (encode || f.beam))
        o << "\tpc_fragColor = sRGBTransferEOTF( pc_fragColor );\n";
    if (f.premultiplied)
        o << "\tpc_fragColor.rgb *= pc_fragColor.a;\n";
}

std::string fragmentShader(const Features &f) {
    Src o;
    header(o, false);
    o << "precision highp float;\nprecision highp int;\nprecision highp sampler2D;\nprecision "
         "highp sampler2DShadow;\n";
    if (f.depth) {
        if (f.map)
            o << "uniform sampler2D uMap;\nin vec2 vMapUv;\n";
        if (f.alphaMap)
            o << "uniform sampler2D uAlphaMap;\nin vec2 vAlphaMapUv;\n";
        if (f.alphaTest)
            o << "uniform float uAlphaTest;\n";
        o << "void main() {\n";
        if (f.map || f.alphaMap || f.alphaTest) {
            // three's depth.glsl.js fragment stage, up to alphatest_fragment.
            o << "\tvec4 diffuseColor = vec4( 1.0 );\n";
            if (f.map)
                o << "\tdiffuseColor *= texture( uMap, vMapUv );\n";
            if (f.alphaMap)
                o << "\tdiffuseColor.a *= texture( uAlphaMap, vAlphaMapUv ).g;\n";
            if (f.alphaTest)
                o << "\tif ( diffuseColor.a < uAlphaTest ) discard;\n";
        }
        o << "}\n";
        return o.s;
    }

    const bool fog = f.fog != FogMode::None;
    const bool needFrame = f.lit || fog;
    if (f.gradientMap)
        o << "#define USE_GRADIENTMAP\n";
    o << kCommon << kColorspace;
    if (needFrame)
        o << frameBlock();
    if (f.skyLit || f.haze)
        o << skyBlock();

    const bool uvMaps = !f.points;
    if (f.map && uvMaps)
        o << "in vec2 vMapUv;\n";
    if (f.alphaMap && uvMaps)
        o << "in vec2 vAlphaMapUv;\n";
    if (f.emissiveMap)
        o << "in vec2 vEmissiveMapUv;\n";
    if (f.vertexColor)
        o << "in vec4 vColor;\n";
    if (f.world)
        o << "in vec3 vSkyWorld;\n";
    if (f.normal)
        o << "in vec3 vNormal;\n";
    if (f.viewNormal)
        o << "in vec3 vViewNormal;\n";
    if (f.toEye)
        o << "in vec3 vToEye;\n";
    if (fog)
        o << "in float vFogDepth;\n";
    if (f.haze)
        o << "in vec2 vSkyFog;\n";
    if (f.shadows)
        o << "in vec4 vShadowCoord;\n";
    if (f.beam)
        o << "in float vAlong;\n";
    if (f.dome)
        o << "in vec3 vDir;\n";
    if (f.points)
        o << "in vec2 vPointCoord;\n";

    o << "uniform vec4 uColor;\n";
    if (f.map)
        o << "uniform sampler2D uMap;\n";
    if (f.alphaMap)
        o << "uniform sampler2D uAlphaMap;\n";
    if (f.points && (f.map || f.alphaMap))
        o << "uniform mat3 uMapTransform;\n";
    if (f.alphaTest)
        o << "uniform float uAlphaTest;\n";
    if (f.lit)
        o << "uniform vec3 uEmissive;\n";
    if (f.emissiveMap)
        o << "uniform sampler2D uEmissiveMap;\n";
    if (f.gradientMap)
        o << "uniform sampler2D uGradientMap;\n";
    if (f.shadows)
        o << "uniform highp sampler2DShadow uShadowMap;\nuniform float uReceiveShadow;\n";
    if (f.model == ShadeModel::Standard)
        o << "uniform vec2 uMetalRough;\n";
    if (f.model == ShadeModel::Phong)
        o << "uniform vec4 uSpecular;\n";
    if (f.dome)
        o << "uniform vec4 uSky0;\nuniform vec4 uSky1;\nuniform vec4 uSky2;\nuniform vec4 "
             "uSky3;\nuniform vec4 uSky4;\n";
    if (f.sharp != SharpDepth::None)
        o << sharpPars(f);
    o << "layout(location = 0) out highp vec4 pc_fragColor;\n";

    if (f.lit) {
        o << kDistanceAttenuation;
        if (f.shadows)
            o << kShadow;
        switch (f.model) {
        case ShadeModel::Toon:
            o << kToon;
            break;
        case ShadeModel::Lambert:
            o << kLambert;
            break;
        case ShadeModel::Phong:
            o << kPhong;
            break;
        default:
            o << kStandard;
            break;
        }
        if (f.skyLit)
            o << skyPars();
    }

    o << "void main() {\n";

    if (f.beam) {
        // world/rooftop.ts beamMaterial(); vN and vView in world space instead of view space.
        o << "\tvec3 vN = vNormal;\n"
             "\tvec3 vView = vToEye;\n"
             "\tfloat edge = pow( abs( dot( normalize( vN ), normalize( vView ) ) ), 1.6 );\n"
             "\tfloat a = uColor.a * vAlong * vAlong * edge;\n"
             "\tpc_fragColor = vec4( uColor.rgb * a, a );\n";
        colorPipeline(o, f);
        o << "}\n";
        return o.s;
    }
    if (f.dome) {
        // world/sky.ts gradientDome().
        o << "\tvec3 top = uSky0.rgb;\n"
             "\tvec3 horizon = uSky1.rgb;\n"
             "\tvec3 glow = uSky2.rgb;\n"
             "\tfloat glowK = uSky2.w;\n"
             "\tvec3 moonDir = uSky3.xyz;\n"
             "\tvec3 moonGlow = uSky4.rgb;\n"
             "\tfloat opacity = uColor.a;\n"
             "\tvec3 d = normalize( vDir );\n"
             "\tvec3 c = mix( horizon, top, smoothstep( 0.0, 0.6, d.y ) );\n"
             "\tc = mix( c, glow, glowK * exp( -abs( d.y ) * 7.0 ) );\n"
             "\tfloat m = max( dot( d, moonDir ), 0.0 );\n"
             "\tc += moonGlow * ( pow( m, 60.0 ) * 0.9 + pow( m, 10.0 ) * 0.14 );\n"
             "\tpc_fragColor = vec4( c, opacity );\n";
        colorPipeline(o, f);
        o << "}\n";
        return o.s;
    }

    if (f.sharp != SharpDepth::None)
        sharpTest(o, f);
    o << "\tvec4 diffuseColor = uColor;\n";
    if (f.lit) {
        o << "\tReflectedLight reflectedLight = ReflectedLight( vec3( 0.0 ), vec3( 0.0 ), vec3( "
             "0.0 ), vec3( 0.0 ) );\n"
             "\tvec3 totalEmissiveRadiance = uEmissive;\n";
    }
    if (f.points) {
        // three's map_particle_fragment: one uv from gl_PointCoord for both maps; a point drawn
        // as a quad carries the same coordinate in vPointCoord.
        if (f.map || f.alphaMap)
            o << "\tvec2 pointCoord = vPointCoord.x < 0.0 ? gl_PointCoord : vPointCoord;\n"
                 "\tvec2 uv = ( uMapTransform * vec3( pointCoord.x, 1.0 - pointCoord.y, 1 ) "
                 ").xy;\n";
        if (f.map)
            o << "\tdiffuseColor *= texture( uMap, uv );\n";
        if (f.alphaMap)
            o << "\tdiffuseColor.a *= texture( uAlphaMap, uv ).g;\n";
        if (f.vertexColor)
            o << "\tdiffuseColor *= vColor;\n";
    } else {
        if (f.map) {
            // Keep thin terminal strokes when the sharp layer slightly minifies its canvas.
            // A half-mip bias retains derivative-based, anisotropic mip filtering at oblique
            // angles and distance. World draws and transparent overlays keep their sampling.
            if (f.sharp != SharpDepth::None && !f.overlay)
                o << "\tdiffuseColor *= texture( uMap, vMapUv, -0.5 );\n";
            else
                o << "\tdiffuseColor *= texture( uMap, vMapUv );\n";
        }
        if (f.vertexColor)
            o << "\tdiffuseColor *= vColor;\n";
        if (f.alphaMap)
            o << "\tdiffuseColor.a *= texture( uAlphaMap, vAlphaMapUv ).g;\n";
    }
    if (f.alphaTest)
        o << "\tif ( diffuseColor.a < uAlphaTest ) discard;\n";

    if (!f.lit) {
        o << "\tvec3 outgoingLight = diffuseColor.rgb;\n";
    } else {
        // normal_fragment_begin, in world space.
        if (f.flatShading) {
            o << "\tvec3 fdx = dFdx( vSkyWorld );\n"
                 "\tvec3 fdy = dFdy( vSkyWorld );\n"
                 "\tvec3 normal = normalize( cross( fdx, fdy ) );\n";
        } else {
            o << "\tvec3 normal = normalize( vNormal );\n";
            if (f.doubleSided)
                o << "\tnormal *= gl_FrontFacing ? 1.0 : - 1.0;\n";
        }
        if (f.emissiveMap)
            o << "\ttotalEmissiveRadiance *= texture( uEmissiveMap, vEmissiveMapUv ).rgb;\n";

        // lights_*_fragment: the material.
        switch (f.model) {
        case ShadeModel::Toon:
            o << "\tToonMaterial material;\n\tmaterial.diffuseColor = diffuseColor.rgb;\n";
            break;
        case ShadeModel::Lambert:
            o << "\tLambertMaterial material;\n\tmaterial.diffuseColor = "
                 "diffuseColor.rgb;\n\tmaterial.specularStrength = 1.0;\n";
            break;
        case ShadeModel::Phong:
            o << "\tBlinnPhongMaterial material;\n"
                 "\tmaterial.diffuseColor = diffuseColor.rgb;\n"
                 "\tmaterial.specularColor = uSpecular.rgb;\n"
                 "\tmaterial.specularShininess = max( uSpecular.a, 1e-4 );\n"
                 "\tmaterial.specularStrength = 1.0;\n";
            break;
        default:
            o << "\tfloat metalnessFactor = uMetalRough.x;\n"
                 "\tfloat roughnessFactor = uMetalRough.y;\n"
                 "\tPhysicalMaterial material;\n"
                 "\tmaterial.diffuseColor = diffuseColor.rgb;\n"
                 "\tmaterial.diffuseContribution = diffuseColor.rgb * ( 1.0 - metalnessFactor );\n"
                 "\tmaterial.metalness = metalnessFactor;\n"
              << (f.viewNormal ? "\tvec3 nonPerturbedNormal = normalize( vViewNormal );\n"
                               : "\tvec3 nonPerturbedNormal = normal;\n")
              << "\tvec2 fovStep = foveatedStep();\n"
                 "\tvec3 dxy = max( abs( dFdx( nonPerturbedNormal ) ) / fovStep.x, abs( dFdy( "
                 "nonPerturbedNormal ) ) / fovStep.y );\n"
                 "\tfloat geometryRoughness = max( max( dxy.x, dxy.y ), dxy.z );\n"
                 "\tmaterial.roughness = max( roughnessFactor, 0.0525 );\n"
                 "\tmaterial.roughness += geometryRoughness;\n"
                 "\tmaterial.roughness = min( material.roughness, 1.0 );\n"
                 "\tmaterial.specularColor = vec3( 0.04 );\n"
                 "\tmaterial.specularColorBlended = mix( material.specularColor, diffuseColor.rgb, "
                 "metalnessFactor );\n"
                 "\tmaterial.specularF90 = 1.0;\n";
            break;
        }
        if (f.skyLit)
            o << kSkySurface;

        // lights_fragment_begin.
        o << "\tvec3 geometryPosition = vSkyWorld;\n"
             "\tvec3 geometryNormal = normal;\n";
        o << (f.toEye ? "\tvec3 geometryViewDir = normalize( vToEye );\n"
                      : "\tvec3 geometryViewDir = vec3( 0.0 );\n");
        if (f.model == ShadeModel::Standard) {
            o << "\tmaterial.dfg = DFGApprox( geometryNormal, geometryViewDir, material.roughness "
                 ");\n"
                 "\tfloat EssMs = material.dfg.x + material.dfg.y;\n"
                 "\tmaterial.multiScatteringCompensation = 1.0 + material.specularColorBlended * ( "
                 "1.0 / EssMs - 1.0 );\n";
        }
        o << "\tIncidentLight directLight;\n"
             "\tfor ( int i = 0; i < " +
                 kMaxPointS +
                 "; i ++ ) {\n"
                 "\t\tif ( i >= uFrame.counts.z ) break;\n"
                 "\t\tvec3 lVector = uFrame.pointPos[ i ].xyz - geometryPosition;\n"
                 "\t\tdirectLight.direction = normalize( lVector );\n"
                 "\t\tfloat lightDistance = length( lVector );\n"
                 "\t\tdirectLight.color = uFrame.pointColor[ i ].rgb;\n"
                 "\t\tdirectLight.color *= getDistanceAttenuation( lightDistance, uFrame.pointPos[ "
                 "i ].w, uFrame.pointColor[ i ].w );\n"
                 "\t\tRE_Direct( directLight, geometryNormal, geometryViewDir, material, "
                 "reflectedLight );\n"
                 "\t}\n"
                 "\tfor ( int i = 0; i < " +
                 kMaxDirS +
                 "; i ++ ) {\n"
                 "\t\tif ( i >= uFrame.counts.y ) break;\n"
                 "\t\tdirectLight.color = uFrame.dirColor[ i ].rgb;\n"
                 "\t\tdirectLight.direction = uFrame.dirDir[ i ].xyz;\n";
        if (f.shadows) {
            o << "\t\tif ( i == uFrame.counts.w && uReceiveShadow > 0.0 ) directLight.color *= "
                 "getShadow( uFrame.shadowMapSize.xy, uFrame.shadowParams.w, "
                 "uFrame.shadowParams.x, uFrame.shadowParams.z, vShadowCoord );\n";
        }
        o << "\t\tRE_Direct( directLight, geometryNormal, geometryViewDir, material, "
             "reflectedLight );\n"
             "\t}\n"
             "\tvec3 irradiance = uFrame.ambient.rgb;\n"
             "\tfor ( int i = 0; i < " +
                 kMaxHemiS +
                 "; i ++ ) {\n"
                 "\t\tif ( i >= uFrame.counts.x ) break;\n"
                 "\t\tfloat dotNL = dot( geometryNormal, uFrame.hemiDir[ i ].xyz );\n"
                 "\t\tfloat hemiDiffuseWeight = 0.5 * dotNL + 0.5;\n"
                 "\t\tirradiance += mix( uFrame.hemiGround[ i ].rgb, uFrame.hemiSky[ i ].rgb, "
                 "hemiDiffuseWeight );\n"
                 "\t}\n"
                 // lights_fragment_end.
                 "\tRE_IndirectDiffuse( irradiance, material, reflectedLight );\n";
        if (f.skyLit)
            o << kSkyLight;
        switch (f.model) {
        case ShadeModel::Toon:
        case ShadeModel::Lambert:
            o << "\tvec3 outgoingLight = reflectedLight.directDiffuse + "
                 "reflectedLight.indirectDiffuse + totalEmissiveRadiance;\n";
            break;
        default:
            o << "\tvec3 outgoingLight = reflectedLight.directDiffuse + "
                 "reflectedLight.indirectDiffuse + reflectedLight.directSpecular + "
                 "reflectedLight.indirectSpecular + totalEmissiveRadiance;\n";
            break;
        }
    }

    // opaque_fragment.
    if (f.opaque)
        o << "\tdiffuseColor.a = 1.0;\n";
    o << "\tpc_fragColor = vec4( outgoingLight, diffuseColor.a );\n";
    colorPipeline(o, f);
    if (f.sharp != SharpDepth::None)
        sharpOutput(o, f);
    o << "}\n";
    return o.s;
}

const char *modelName(ShadeModel m) {
    switch (m) {
    case ShadeModel::Basic:
        return "basic";
    case ShadeModel::Toon:
        return "toon";
    case ShadeModel::Lambert:
        return "lambert";
    case ShadeModel::Phong:
        return "phong";
    case ShadeModel::Standard:
        return "standard";
    case ShadeModel::Points:
        return "points";
    case ShadeModel::Line:
        return "line";
    case ShadeModel::Sprite:
        return "sprite";
    case ShadeModel::Beam:
        return "beam";
    case ShadeModel::SkyDome:
        return "skydome";
    case ShadeModel::Depth:
        return "depth";
    }
    return "unknown";
}

} // namespace

ShaderSource generateShader(const ProgramKey &key) {
    const Features f = features(key);
    return {vertexShader(f), fragmentShader(f)};
}

std::string programName(const ProgramKey &key) {
    std::string n = modelName(key.model);
    auto add = [&n](bool on, const char *s) {
        if (on)
            (n += '+') += s;
    };
    add(key.map, "map");
    add(key.alphaMap, "alphamap");
    add(key.emissiveMap, "emissive");
    add(key.gradientMap, "gradient");
    add(key.alphaTest, "alphatest");
    add(key.opaque, "opaque");
    add(key.premultipliedAlpha, "premul");
    add(key.doubleSided, "double");
    add(key.backSide, "back");
    add(key.flatShading, "flat");
    add(!key.sizeAttenuation, "fixedsize");
    add(key.sky, "sky");
    add(key.fog == FogMode::Linear, "fog");
    add(key.fog == FogMode::Exp2, "fog2");
    add(key.shadows, "shadow");
    add(!key.linearOutput, "srgbout");
    add(key.sharpDepth == SharpDepth::Texture2D, "sharp2d");
    add(key.sharpDepth == SharpDepth::Array, "sharparray");
    add(key.sharpOverlay, "overlay");
    add(key.multiview, "mv");
    return n;
}

} // namespace office::scene
