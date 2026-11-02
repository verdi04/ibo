import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { normalizeMac } from '@/lib/iptv-crypto';
import { calculateDeviceStatus } from '@/lib/device-status';
import {
  getClientIp,
  checkLoginRateLimit,
  recordFailedLogin,
  resetLoginRateLimit,
} from '@/lib/rate-limiter';
import { createPortalToken } from '@/lib/portal-auth';

export async function POST(request) {
  try {
    const clientIp = getClientIp(request);

    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { success: false, error: 'صيغة البيانات غير صحيحة، يرجى إرسال JSON صالح.' },
        { status: 400 },
      );
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json(
        { success: false, error: 'محتوى الطلب يجب أن يكون كائن JSON.' },
        { status: 400 },
      );
    }

    const { mac_address, device_key } = body;

    const normalizedMac = normalizeMac(mac_address);
    if (!normalizedMac) {
      return NextResponse.json(
        {
          success: false,
          error:
            'عنوان الماك mac_address غير صالح. يرجى التأكد من الصيغة (مثال: 00:1A:2B:3C:4D:5E).',
        },
        { status: 400 },
      );
    }

    if (
      typeof device_key !== 'string' ||
      !/^\d{6}$/.test(device_key.trim())
    ) {
      return NextResponse.json(
        {
          success: false,
          error: 'مفتاح الجهاز device_key يجب أن يتكون من 6 أرقام.',
        },
        { status: 400 },
      );
    }

    const cleanKey = device_key.trim();
    const rateLimitIdentifier = `${clientIp}:${normalizedMac}`;

    // Check rate limit against brute-forcing
    const rateCheck = checkLoginRateLimit(rateLimitIdentifier, 5, 15 * 60 * 1000);
    if (!rateCheck.allowed) {
      return NextResponse.json(
        {
          success: false,
          error:
            'تم حظر المحاولات مؤقتاً بسبب تكرار إدخال بيانات خاطئة. يرجى المحاولة بعد 15 دقيقة.',
          retry_after: rateCheck.retryAfterSeconds,
        },
        {
          status: 429,
          headers: {
            'Retry-After': String(rateCheck.retryAfterSeconds),
          },
        },
      );
    }

    // Query device in Supabase
    const { data: device, error: selectError } = await supabase
      .from('devices')
      .select('*')
      .eq('mac_address', normalizedMac)
      .maybeSingle();

    if (selectError) {
      console.error('Database error in portal login:', selectError);
      return NextResponse.json(
        { success: false, error: 'حدث خطأ في قاعدة البيانات أثناء تسجيل الدخول.' },
        { status: 500 },
      );
    }

    // Verify existence and device_key
    if (!device || device.device_key !== cleanKey) {
      recordFailedLogin(rateLimitIdentifier, 15 * 60 * 1000);
      return NextResponse.json(
        {
          success: false,
          error: 'بيانات الدخول غير صحيحة. يرجى التأكد من عنوان MAC ومفتاح الجهاز (Device Key).',
        },
        { status: 401 },
      );
    }

    // Successful login: reset rate limiter
    resetLoginRateLimit(rateLimitIdentifier);

    // Calculate real-time status and days remaining
    const statusInfo = calculateDeviceStatus(device);

    if (device.status !== statusInfo.status) {
      await supabase
        .from('devices')
        .update({ status: statusInfo.status, updated_at: new Date().toISOString() })
        .eq('id', device.id);
      device.status = statusInfo.status;
    }

    // Generate signed portal session token
    const token = createPortalToken({
      device_id: device.id,
      mac_address: device.mac_address,
    });

    return NextResponse.json({
      success: true,
      message: 'تم تسجيل الدخول بنجاح.',
      token,
      device: {
        id: device.id,
        mac_address: device.mac_address,
        device_key: device.device_key,
        status: statusInfo.status,
        is_valid: statusInfo.is_valid,
        days_remaining: statusInfo.days_remaining,
        trial_ends_at: device.trial_ends_at,
        license_expires_at: device.license_expires_at,
        device_type: device.device_type,
        last_seen_at: device.last_seen_at,
        created_at: device.created_at,
      },
    });
  } catch (error) {
    console.error('Unhandled error in portal login:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'حدث خطأ داخلي في الخادم أثناء تسجيل الدخول.',
      },
      { status: 500 },
    );
  }
}
