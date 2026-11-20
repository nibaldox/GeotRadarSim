//! Bit-exact ports of the JavaScript (V8) `Math.*` semantics used by the LOS worker.
//!
//! Rust's `f64::round`, `f64::min`, `f64::max`, `f64::hypot` and `f64::atan2` do not
//! match V8 in every case (ties, NaN propagation, signed zeros, algorithms), so the LOS
//! port calls these helpers instead. Every helper is plain IEEE-754 arithmetic without
//! fused multiply-add, so native and `wasm32` builds produce the same bits.

/// `Math.round`: V8 `Float64Round` (ceil, then step down when `ceil - 0.5 > x`).
///
/// Halves round toward +∞, `-0` and values in `[-0.5, -0)` yield `-0`, NaN/±∞ pass through.
pub fn js_round(x: f64) -> f64 {
    let up = x.ceil();
    if up - 0.5 <= x { up } else { up - 1.0 }
}

/// `Math.min(a, b)`: NaN if any argument is NaN; `-0` is smaller than `+0`.
pub fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    if a < b {
        a
    } else if b < a {
        b
    } else if a.is_sign_negative() {
        a
    } else {
        b
    }
}

/// `Math.max(a, b)`: NaN if any argument is NaN; `+0` is larger than `-0`.
pub fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    if a > b {
        a
    } else if b > a {
        b
    } else if a.is_sign_positive() {
        a
    } else {
        b
    }
}

/// Variadic `Math.min`, folded left exactly as the specification orders it.
pub fn js_min_n(values: &[f64]) -> f64 {
    values.iter().fold(f64::INFINITY, |acc, &v| js_min(acc, v))
}

/// Variadic `Math.max`, folded left exactly as the specification orders it.
pub fn js_max_n(values: &[f64]) -> f64 {
    values
        .iter()
        .fold(f64::NEG_INFINITY, |acc, &v| js_max(acc, v))
}

/// `Math.hypot(...values)`: V8 `MathHypot` (Torque builtin) — scale by the largest
/// magnitude, then Kahan-compensated sum of squares, `sqrt(sum) * max`.
pub fn v8_hypot(values: &[f64]) -> f64 {
    let mut max = 0.0_f64;
    let mut one_arg_is_nan = false;
    for &value in values {
        if value.is_nan() {
            one_arg_is_nan = true;
        } else {
            let abs = value.abs();
            if abs > max {
                max = abs;
            }
        }
    }
    if max == f64::INFINITY {
        return f64::INFINITY;
    } else if one_arg_is_nan {
        return f64::NAN;
    } else if max == 0.0 {
        return 0.0;
    }
    let mut sum = 0.0_f64;
    let mut compensation = 0.0_f64;
    for &value in values {
        // NaN entries are impossible here (returned above); V8 stores 0 for them anyway.
        let n = value.abs() / max;
        let summand = n * n - compensation;
        let preliminary = sum + summand;
        compensation = (preliminary - sum) - summand;
        sum = preliminary;
    }
    sum.sqrt() * max
}

/// `Math.hypot(a, b)` (V8 algorithm).
pub fn js_hypot2(a: f64, b: f64) -> f64 {
    v8_hypot(&[a, b])
}

/// `Math.hypot(a, b, c)` (V8 algorithm).
pub fn js_hypot3(a: f64, b: f64, c: f64) -> f64 {
    v8_hypot(&[a, b, c])
}

fn high_word(x: f64) -> i32 {
    (x.to_bits() >> 32) as u32 as i32
}

fn low_word(x: f64) -> u32 {
    x.to_bits() as u32
}

/// fdlibm `atan` exactly as ported in V8 `src/base/ieee754.cc`.
pub fn fdlibm_atan(x: f64) -> f64 {
    // fdlibm high/low words, as bit patterns (see `fdlibm_constants_match_decimal_literals`).
    const ATANHI: [f64; 4] = [
        f64::from_bits(0x3FDD_AC67_0561_BB4F), // atan(0.5)hi
        f64::from_bits(0x3FE9_21FB_5444_2D18), // atan(1.0)hi
        f64::from_bits(0x3FEF_730B_D281_F69B), // atan(1.5)hi
        f64::from_bits(0x3FF9_21FB_5444_2D18), // atan(inf)hi
    ];
    const ATANLO: [f64; 4] = [
        f64::from_bits(0x3C7A_2B7F_222F_65E2),
        f64::from_bits(0x3C81_A626_3314_5C07),
        f64::from_bits(0x3C70_0788_7AF0_CBBD),
        f64::from_bits(0x3C91_A626_3314_5C07),
    ];
    const AT: [f64; 11] = [
        f64::from_bits(0x3FD5_5555_5555_550D),
        f64::from_bits(0xBFC9_9999_9998_EBC4),
        f64::from_bits(0x3FC2_4924_9200_83FF),
        f64::from_bits(0xBFBC_71C6_FE23_1671),
        f64::from_bits(0x3FB7_45CD_C54C_206E),
        f64::from_bits(0xBFB3_B0F2_AF74_9A6D),
        f64::from_bits(0x3FB1_0D66_A0D0_3D51),
        f64::from_bits(0xBFAD_DE2D_52DE_FD9A),
        f64::from_bits(0x3FA9_7B4B_2476_0DEB),
        f64::from_bits(0xBFA2_B444_2C6A_6C2F),
        f64::from_bits(0x3F90_AD3A_E322_DA11),
    ];
    const ONE: f64 = 1.0;
    const HUGE: f64 = 1.0e300;

    let mut x = x;
    let hx = high_word(x);
    let ix = hx & 0x7FFF_FFFF;
    let id: i32;
    if ix >= 0x4410_0000 {
        // |x| >= 2^66
        let low = low_word(x);
        if ix > 0x7FF0_0000 || (ix == 0x7FF0_0000 && low != 0) {
            return x + x; // NaN
        }
        return if hx > 0 {
            ATANHI[3] + ATANLO[3]
        } else {
            -ATANHI[3] - ATANLO[3]
        };
    }
    if ix < 0x3FDC_0000 {
        // |x| < 0.4375
        if ix < 0x3E40_0000 && HUGE + x > ONE {
            // |x| < 2^-27; raise inexact
            return x;
        }
        id = -1;
    } else {
        x = x.abs();
        if ix < 0x3FF3_0000 {
            // |x| < 1.1875
            if ix < 0x3FE6_0000 {
                // 7/16 <= |x| < 11/16
                id = 0;
                x = (2.0 * x - ONE) / (2.0 + x);
            } else {
                // 11/16 <= |x| < 19/16
                id = 1;
                x = (x - ONE) / (x + ONE);
            }
        } else if ix < 0x4003_8000 {
            // |x| < 2.4375
            id = 2;
            x = (x - 1.5) / (ONE + 1.5 * x);
        } else {
            // 2.4375 <= |x| < 2^66
            id = 3;
            x = -1.0 / x;
        }
    }
    let z = x * x;
    let w = z * z;
    let s1 = z * (AT[0] + w * (AT[2] + w * (AT[4] + w * (AT[6] + w * (AT[8] + w * AT[10])))));
    let s2 = w * (AT[1] + w * (AT[3] + w * (AT[5] + w * (AT[7] + w * AT[9]))));
    if id < 0 {
        x - x * (s1 + s2)
    } else {
        let index = id as usize;
        let z = ATANHI[index] - ((x * (s1 + s2) - ATANLO[index]) - x);
        if hx < 0 { -z } else { z }
    }
}

/// `Math.atan2(y, x)`: fdlibm `atan2` exactly as ported in V8 `src/base/ieee754.cc`.
pub fn fdlibm_atan2(y: f64, x: f64) -> f64 {
    const TINY: f64 = 1.0e-300;
    const ZERO: f64 = 0.0;
    const PI_O_4: f64 = f64::from_bits(0x3FE9_21FB_5444_2D18);
    const PI_O_2: f64 = f64::from_bits(0x3FF9_21FB_5444_2D18);
    const PI: f64 = f64::from_bits(0x4009_21FB_5444_2D18);
    const PI_LO: f64 = f64::from_bits(0x3CA1_A626_3314_5C07);

    let hx = high_word(x);
    let lx = low_word(x);
    let ix = hx & 0x7FFF_FFFF;
    let hy = high_word(y);
    let ly = low_word(y);
    let iy = hy & 0x7FFF_FFFF;
    let x_nan_bit = ((lx | lx.wrapping_neg()) >> 31) as i32;
    let y_nan_bit = ((ly | ly.wrapping_neg()) >> 31) as i32;
    if (ix | x_nan_bit) > 0x7FF0_0000 || (iy | y_nan_bit) > 0x7FF0_0000 {
        return x + y; // x or y is NaN
    }
    if (hx.wrapping_sub(0x3FF0_0000) as u32 | lx) == 0 {
        return fdlibm_atan(y); // x = 1.0
    }
    let m = ((hy >> 31) & 1) | ((hx >> 30) & 2); // 2*sign(x) + sign(y)

    if (iy as u32 | ly) == 0 {
        // y = 0
        return match m {
            0 | 1 => y,
            2 => PI + TINY,
            _ => -PI - TINY,
        };
    }
    if (ix as u32 | lx) == 0 {
        // x = 0
        return if hy < 0 {
            -PI_O_2 - TINY
        } else {
            PI_O_2 + TINY
        };
    }
    if ix == 0x7FF0_0000 {
        // x is INF
        if iy == 0x7FF0_0000 {
            return match m {
                0 => PI_O_4 + TINY,
                1 => -PI_O_4 - TINY,
                2 => 3.0 * PI_O_4 + TINY,
                _ => -3.0 * PI_O_4 - TINY,
            };
        }
        return match m {
            0 => ZERO,
            1 => -ZERO,
            2 => PI + TINY,
            _ => -PI - TINY,
        };
    }
    if iy == 0x7FF0_0000 {
        // y is INF
        return if hy < 0 {
            -PI_O_2 - TINY
        } else {
            PI_O_2 + TINY
        };
    }

    let k = (iy - ix) >> 20;
    let mut m = m;
    let z = if k > 60 {
        // |y/x| > 2^60
        m &= 1;
        PI_O_2 + 0.5 * PI_LO
    } else if hx < 0 && k < -60 {
        0.0 // 0 > |y|/x > -2^-60
    } else {
        fdlibm_atan((y / x).abs())
    };
    match m {
        0 => z,
        1 => -z,
        2 => PI - (z - PI_LO),
        _ => (z - PI_LO) - PI,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn same_bits(a: f64, b: f64) -> bool {
        (a.is_nan() && b.is_nan()) || a.to_bits() == b.to_bits()
    }

    #[test]
    fn js_round_matches_ecmascript_ties_and_signed_zero() {
        let cases: [(f64, f64); 16] = [
            (0.5, 1.0),
            (1.5, 2.0),
            (2.5, 3.0),
            (-0.5, -0.0),
            (-1.5, -1.0),
            (-2.5, -2.0),
            (-0.3, -0.0),
            (0.3, 0.0),
            (-0.0, -0.0),
            (0.0, 0.0),
            (0.499_999_999_999_999_94, 0.0),
            (-0.7, -1.0),
            (4_503_599_627_370_497.0, 4_503_599_627_370_497.0),
            (9_007_199_254_740_993.0, 9_007_199_254_740_993.0),
            (f64::INFINITY, f64::INFINITY),
            (f64::NEG_INFINITY, f64::NEG_INFINITY),
        ];
        for (input, expected) in cases {
            assert!(same_bits(js_round(input), expected), "round({input})");
        }
        assert!(js_round(f64::NAN).is_nan());
        // Rust's round differs on these ties: documents why js_round exists.
        assert_eq!((-2.5_f64).round(), -3.0);
        assert_eq!(js_round(-2.5), -2.0);
    }

    #[test]
    fn js_min_max_propagate_nan_and_order_signed_zero() {
        assert!(js_min(f64::NAN, 1.0).is_nan());
        assert!(js_min(1.0, f64::NAN).is_nan());
        assert!(js_max(f64::NAN, 1.0).is_nan());
        assert!(js_max(1.0, f64::NAN).is_nan());
        // Rust's min/max ignore NaN: documents why js_min/js_max exist.
        assert_eq!(f64::NAN.min(1.0), 1.0);
        assert!(same_bits(js_min(0.0, -0.0), -0.0));
        assert!(same_bits(js_min(-0.0, 0.0), -0.0));
        assert!(same_bits(js_max(0.0, -0.0), 0.0));
        assert!(same_bits(js_max(-0.0, 0.0), 0.0));
        assert_eq!(js_min(2.0, -3.0), -3.0);
        assert_eq!(js_max(2.0, -3.0), 2.0);
        assert!(js_min_n(&[1.0, f64::NAN, -5.0]).is_nan());
        assert_eq!(js_min_n(&[1.0, 0.25, 0.5, f64::INFINITY]), 0.25);
        assert!(same_bits(js_max_n(&[-0.0, 0.0]), 0.0));
    }

    #[test]
    fn v8_hypot_special_values_and_scaling() {
        assert!(same_bits(js_hypot2(0.0, -0.0), 0.0));
        assert_eq!(js_hypot2(3.0, 4.0), 5.0);
        assert_eq!(js_hypot2(f64::NAN, f64::INFINITY), f64::INFINITY);
        assert!(js_hypot2(f64::NAN, 1.0).is_nan());
        assert_eq!(js_hypot2(1e308, 1e308), 1.414_213_562_373_095_1e308);
        assert_eq!(js_hypot3(0.0, 0.0, 1.0), 1.0);
        assert_eq!(js_hypot3(2.0, 3.0, 6.0), 7.0);
        assert!(js_hypot3(1.0, f64::NAN, 1.0).is_nan());
        assert_eq!(v8_hypot(&[]), 0.0);
        // The scaled, compensated algorithm is order sensitive like V8's: the result is the
        // largest-normalized Kahan sum, not libm's correctly rounded hypot.
        let v = js_hypot2(1.0, 1e-8);
        assert_eq!(v, (1.0_f64 + 1e-16).sqrt());
    }

    #[test]
    fn fdlibm_atan2_special_cases() {
        let pi = std::f64::consts::PI;
        let half = std::f64::consts::FRAC_PI_2;
        let quarter = std::f64::consts::FRAC_PI_4;
        assert!(fdlibm_atan2(f64::NAN, 1.0).is_nan());
        assert!(fdlibm_atan2(1.0, f64::NAN).is_nan());
        assert!(same_bits(fdlibm_atan2(0.0, 1.0), 0.0));
        assert!(same_bits(fdlibm_atan2(-0.0, 1.0), -0.0));
        assert!(same_bits(fdlibm_atan2(0.0, 5.0), 0.0));
        assert!(same_bits(fdlibm_atan2(-0.0, 5.0), -0.0));
        assert_eq!(fdlibm_atan2(0.0, -0.0), pi);
        assert_eq!(fdlibm_atan2(-0.0, -1.0), -pi);
        assert_eq!(fdlibm_atan2(1.0, 0.0), half);
        assert_eq!(fdlibm_atan2(-1.0, -0.0), -half);
        assert_eq!(fdlibm_atan2(f64::INFINITY, f64::INFINITY), quarter);
        assert_eq!(fdlibm_atan2(-f64::INFINITY, -f64::INFINITY), -3.0 * quarter);
        assert!(same_bits(fdlibm_atan2(1.0, f64::INFINITY), 0.0));
        assert!(same_bits(fdlibm_atan2(-1.0, f64::INFINITY), -0.0));
        assert_eq!(fdlibm_atan2(1.0, f64::NEG_INFINITY), pi);
        assert_eq!(fdlibm_atan2(f64::INFINITY, 1.0), half);
        assert_eq!(fdlibm_atan2(1.0, 1.0), quarter);
        assert_eq!(fdlibm_atan2(-1.0, -1.0), -3.0 * quarter);
        assert_eq!(fdlibm_atan2(1e300, 1e-10), half);
        assert_eq!(fdlibm_atan2(1e-300, -1e10), pi);
        // fdlibm atan2 is accurate to < 1 ulp; spot-check against the correctly rounded value.
        assert_eq!(fdlibm_atan2(1.0, 2.0), 0.463_647_609_000_806_1);
        assert_eq!(fdlibm_atan(1.0), quarter);
        assert!(same_bits(fdlibm_atan(-0.0), -0.0));
        assert_eq!(fdlibm_atan(f64::INFINITY), half);
    }

    #[test]
    fn fdlibm_constants_match_decimal_literals() {
        // Decimal literals copied from fdlibm s_atan.c / e_atan2.c; parsing is correctly rounded.
        let pairs: [(u64, &str); 23] = [
            (0x3FDD_AC67_0561_BB4F, "4.63647609000806093515e-01"),
            (0x3FE9_21FB_5444_2D18, "7.85398163397448278999e-01"),
            (0x3FEF_730B_D281_F69B, "9.82793723247329054082e-01"),
            (0x3FF9_21FB_5444_2D18, "1.57079632679489655800e+00"),
            (0x3C7A_2B7F_222F_65E2, "2.26987774529616870924e-17"),
            (0x3C81_A626_3314_5C07, "3.06161699786838301793e-17"),
            (0x3C70_0788_7AF0_CBBD, "1.39033110312309984516e-17"),
            (0x3C91_A626_3314_5C07, "6.12323399573676603587e-17"),
            (0x3FD5_5555_5555_550D, "3.33333333333329318027e-01"),
            (0xBFC9_9999_9998_EBC4, "-1.99999999998764832476e-01"),
            (0x3FC2_4924_9200_83FF, "1.42857142725034663711e-01"),
            (0xBFBC_71C6_FE23_1671, "-1.11111104054623557880e-01"),
            (0x3FB7_45CD_C54C_206E, "9.09088713343650656196e-02"),
            (0xBFB3_B0F2_AF74_9A6D, "-7.69187620504482999495e-02"),
            (0x3FB1_0D66_A0D0_3D51, "6.66107313738753120669e-02"),
            (0xBFAD_DE2D_52DE_FD9A, "-5.83357013379057348645e-02"),
            (0x3FA9_7B4B_2476_0DEB, "4.97687799461593236017e-02"),
            (0xBFA2_B444_2C6A_6C2F, "-3.65315727442169155270e-02"),
            (0x3F90_AD3A_E322_DA11, "1.62858201153657823623e-02"),
            (0x3FE9_21FB_5444_2D18, "7.8539816339744827900E-01"),
            (0x3FF9_21FB_5444_2D18, "1.5707963267948965580E+00"),
            (0x4009_21FB_5444_2D18, "3.1415926535897931160E+00"),
            (0x3CA1_A626_3314_5C07, "1.2246467991473531772E-16"),
        ];
        for (bits, text) in pairs {
            let parsed: f64 = text.parse().unwrap();
            assert_eq!(parsed.to_bits(), bits, "{text}");
        }
        assert_eq!(f64::from_bits(0x4009_21FB_5444_2D18), std::f64::consts::PI);
    }
}
