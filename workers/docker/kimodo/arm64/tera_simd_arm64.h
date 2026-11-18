// arm64 stand-in for <immintrin.h> in Kimodo's MotionCorrection: SSE via sse2neon (MIT)
// plus the single AVX intrinsic it uses, _mm_permutevar_ps.
#pragma once
#include "sse2neon.h"
#include <stdint.h>

static inline __m128 _mm_permutevar_ps(__m128 a, __m128i ctrl)
{
    float av[4], r[4];
    int32_t cv[4];
    _mm_storeu_ps(av, a);
    _mm_storeu_si128((__m128i*)cv, ctrl);
    for (int i = 0; i < 4; ++i) r[i] = av[cv[i] & 3];
    return _mm_loadu_ps(r);
}
