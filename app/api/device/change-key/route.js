import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import {
  normalizeMac,
  generateDeviceKey,
  encryptPayload,
  deriveEcdhSessionKey,
  signHandshakeResponse,
  safeEquals,
} from '@/lib/iptv-crypto';
import { createPortalToken } from '@/lib/portal-auth';
import {
  getClientIp,
  checkEndpointRateLimit,
  checkLoginRateLimit,
  recordFailedLogin,
  resetLoginRateLimit,
} from '@/lib/rate-limiter';

export async function POST(request) {
  try {
    const clientIp = getClientIp(request);
    const rateCheck = checkEndpointRateLimit(`change_key:${clientIp}`, 20, 60 * 1000);
    if (!rateCheck.allowed) {
      return NextResponse.json(
        {
          success: false,
          error: 'تم تجاوز معدل الطلبات المسموح به. يرجى الانتظار قليلاً.',
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

    const { mac_address, current_key, device_key } = body;
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

    const keyRateLimitKey = `change_key:${clientIp}:${normalizedMac}`;
    const macLockKey = `mac_lock:${normalizedMac}`;
    const keyAttemptCheck = checkLoginRateLimit(keyRateLimitKey, 5, 15 * 60 * 1000);
    const macAttemptCheck = checkLoginRateLimit(macLockKey, 10, 15 * 60 * 1000);
    if (!keyAttemptCheck.allowed || !macAttemptCheck.allowed) {
      const retryAfter = Math.max(
        keyAttemptCheck.retryAfterSeconds || 0,
        macAttemptCheck.retryAfterSeconds || 0,
        60,
      );
      return NextResponse.json(
        {
          success: false,
          error:
            'تم حظر المحاولات مؤقتاً بسبب تكرار إدخال بيانات خاطئة. يرجى المحاولة بعد 15 دقيقة.',
          retry_after: retryAfter,
        },
        {
          status: 429,
          headers: {
            'Retry-After': String(retryAfter),
          },
        },
      );
    }

    const { data: device, error: selectError } = await supabase
      .from('devices')
      .select('*')
      .eq('mac_address', normalizedMac)
      .maybeSingle();

    if (selectError) {
      console.error('Database error finding device for key renewal:', selectError);
      return NextResponse.json(
        { success: false, error: 'حدث خطأ أثناء البحث عن الجهاز.' },
        { status: 500 },
      );
    }

    if (!device) {
      return NextResponse.json(
        { success: false, error: 'الجهاز غير مسجل في النظام.' },
        { status: 404 },
      );
    }

    // Rotating a key is a privilege-changing action: the caller must prove it already
    // holds the current one, and must not be allowed to discover it by guessing.
    const providedKey = current_key || device_key;
    if (
      typeof providedKey !== 'string' ||
      !providedKey.trim() ||
      !safeEquals(providedKey.trim(), device.device_key)
    ) {
      recordFailedLogin(keyRateLimitKey, 15 * 60 * 1000);
      recordFailedLogin(macLockKey, 15 * 60 * 1000);
      return NextResponse.json(
        {
          success: false,
          error: 'مفتاح الجهاز الحالي مطلوب وغير صحيح.',
        },
        { status: 401 },
      );
    }

    resetLoginRateLimit(keyRateLimitKey);
    resetLoginRateLimit(macLockKey);

    // Generate new key distinct from current key
    let newKey = generateDeviceKey();
    while (newKey === device.device_key) {
      newKey = generateDeviceKey();
    }

    const updatedAt = new Date().toISOString();

    const { error: updateError } = await supabase
      .from('devices')
      .update({
        device_key: newKey,
        updated_at: updatedAt,
      })
      .eq('id', device.id);

    if (updateError) {
      console.error('Database error updating device_key:', updateError);
      return NextResponse.json(
        { success: false, error: 'تعذر تحديث مفتاح الجهاز في قاعدة البيانات.' },
        { status: 500 },
      );
    }

    const responsePayload = {
      message: 'تم تجديد مفتاح الجهاز بنجاح',
      mac_address: normalizedMac,
      device_key: newKey,
      updated_at: updatedAt,
    };

    const clientPubKey =
      typeof body.client_pubkey === 'string' ? body.client_pubkey.trim() : '';

    if (clientPubKey) {
      const { aesKey, serverPublicKey } = deriveEcdhSessionKey(
        clientPubKey,
        normalizedMac,
      );
      const pairEncrypted = encryptPayload(responsePayload, aesKey);
      const { signature } = signHandshakeResponse({
        mac: normalizedMac,
        clientPublicKey: clientPubKey,
        serverPublicKey,
        combined: pairEncrypted.combined,
      });

      return NextResponse.json({
        success: true,
        encrypted: true,
        mode: 'pair',
        server_pubkey: serverPublicKey,
        payload: pairEncrypted.combined,
        sig: signature,
      });
    }

    // Issue a fresh portal session token bound to the new device_key; all previously
    // issued tokens for this device become invalid immediately.
    const newPortalToken = createPortalToken({
      device_id: device.id,
      mac_address: normalizedMac,
      device_key: newKey,
    });

    return NextResponse.json({
      success: true,
      message: responsePayload.message,
      mac_address: normalizedMac,
      device_key: newKey,
      token: newPortalToken,
      updated_at: updatedAt,
    });
  } catch (error) {
    console.error('Unhandled error in device change-key:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'حدث خطأ غير متوقع أثناء تجديد مفتاح الجهاز.',
      },
      { status: 500 },
    );
  }
}
