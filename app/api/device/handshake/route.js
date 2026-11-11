import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import {
  normalizeMac,
  generateDeviceKey,
  encryptPayload,
  decryptPassword,
  deriveEcdhSessionKey,
  signHandshakeResponse,
  safeEquals,
} from '@/lib/iptv-crypto';
import { calculateDeviceStatus } from '@/lib/device-status';
import {
  getClientIp,
  checkEndpointRateLimit,
  checkLoginRateLimit,
  recordFailedLogin,
  resetLoginRateLimit,
} from '@/lib/rate-limiter';
import { normalizeAndMigratePlaylistRow } from '@/lib/xtream-parser';

export async function POST(request) {
  try {
    const clientIp = getClientIp(request);
    const rateCheck = checkEndpointRateLimit(`handshake:${clientIp}`, 60, 60 * 1000);
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

    const { mac_address, device_type, device_key } = body;
    const clientPubKey =
      typeof body.client_pubkey === 'string' ? body.client_pubkey.trim() : '';

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

    if (!clientPubKey || !/^04[0-9a-fA-F]{128}$/.test(clientPubKey)) {
      return NextResponse.json(
        {
          success: false,
          error:
            'مفتاح الجلسة المؤقت client_pubkey مطلوب وبصيغة صحيحة لإتمام المصافحة المشفرة.',
        },
        { status: 400 },
      );
    }

    const effectiveDeviceType =
      typeof device_type === 'string' && device_type.trim()
        ? device_type.trim().slice(0, 50)
        : 'Android TV';

    // The device key is the only bearer secret the device holds, so guessing it must be
    // as expensive here as it is at portal login (guarded both per IP+MAC and globally per MAC).
    const keyRateLimitKey = `handshake:${clientIp}:${normalizedMac}`;
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

    const now = new Date();

    // Check if device is already registered
    const { data: existingDevice, error: selectError } = await supabase
      .from('devices')
      .select('*')
      .eq('mac_address', normalizedMac)
      .maybeSingle();

    if (selectError) {
      console.error('Database error in device handshake select:', selectError);
      return NextResponse.json(
        { success: false, error: 'حدث خطأ أثناء فحص بيانات الجهاز.' },
        { status: 500 },
      );
    }

    // Proof of possession: a registered device must present its key before the server
    // discloses status, the key itself, or any playlist credentials.
    if (existingDevice) {
      const claimedKey =
        typeof device_key === 'string' ? device_key.trim() : '';

      if (!claimedKey || !safeEquals(claimedKey, existingDevice.device_key)) {
        recordFailedLogin(keyRateLimitKey, 15 * 60 * 1000);
        recordFailedLogin(macLockKey, 15 * 60 * 1000);
        return NextResponse.json(
          {
            success: false,
            error:
              'مفتاح الجهاز غير صحيح أو مفقود. إذا أعدت تثبيت التطبيق فيجب تجديد المفتاح من البوابة ثم إعادة التفعيل.',
          },
          { status: 401 },
        );
      }

      resetLoginRateLimit(keyRateLimitKey);
      resetLoginRateLimit(macLockKey);
    }

    let device = existingDevice;
    let playlists = [];

    if (!device) {
      // Guard against fake-MAC database flooding (max 5 new device registrations per IP per hour)
      const regRateCheck = checkEndpointRateLimit(
        `register:${clientIp}`,
        5,
        60 * 60 * 1000,
      );
      if (!regRateCheck.allowed) {
        return NextResponse.json(
          {
            success: false,
            error: 'تم تجاوز الحد المسموح لتسجيل أجهزة جديدة. يرجى المحاولة لاحقاً.',
            retry_after: regRateCheck.retryAfterSeconds,
          },
          {
            status: 429,
            headers: {
              'Retry-After': String(regRateCheck.retryAfterSeconds),
            },
          },
        );
      }

      // New device: generate device_key, 7-day trial, status = 'trial'
      let uniqueKey = generateDeviceKey();

      // Ensure key uniqueness
      let attempts = 0;
      while (attempts < 5) {
        const { data: collision } = await supabase
          .from('devices')
          .select('id')
          .eq('device_key', uniqueKey)
          .maybeSingle();

        if (!collision) break;
        uniqueKey = generateDeviceKey();
        attempts++;
      }

      const trialEndsAt = new Date(
        now.getTime() + 7 * 24 * 60 * 60 * 1000,
      ).toISOString();

      const newDeviceRecord = {
        mac_address: normalizedMac,
        device_key: uniqueKey,
        status: 'trial',
        trial_ends_at: trialEndsAt,
        license_expires_at: null,
        device_type: effectiveDeviceType,
        last_seen_at: now.toISOString(),
      };

      const { data: insertedDevice, error: insertError } = await supabase
        .from('devices')
        .insert(newDeviceRecord)
        .select('*')
        .single();

      if (insertError) {
        console.error('Database error in device insert:', insertError);
        return NextResponse.json(
          { success: false, error: 'تعذر إنشاء سجل للجهاز الجديد.' },
          { status: 500 },
        );
      }

      device = insertedDevice;
      playlists = [];
    } else {
      // Existing device: update last_seen_at and fetch active playlists only if subscription is valid
      const statusInfo = calculateDeviceStatus(device);

      const updateData = {
        last_seen_at: now.toISOString(),
      };

      if (device.status !== statusInfo.status) {
        updateData.status = statusInfo.status;
        device.status = statusInfo.status;
      }

      if (
        effectiveDeviceType &&
        device.device_type !== effectiveDeviceType
      ) {
        updateData.device_type = effectiveDeviceType;
        device.device_type = effectiveDeviceType;
      }

      const { error: updateError } = await supabase
        .from('devices')
        .update(updateData)
        .eq('id', device.id);

      if (updateError) {
        console.error('Database error updating device last_seen:', updateError);
      }

      // Entitlement check: never disclose playlists or Xtream credentials to an expired device
      if (statusInfo.is_valid) {
        const { data: dbPlaylists, error: playlistError } = await supabase
          .from('playlists')
          .select('*')
          .eq('device_id', device.id)
          .eq('is_active', true)
          .order('id', { ascending: true });

        if (playlistError) {
          console.error('Database error fetching playlists:', playlistError);
        } else if (dbPlaylists) {
          const normalizedRows = await Promise.all(
            dbPlaylists.map((p) => normalizeAndMigratePlaylistRow(supabase, p)),
          );
          playlists = normalizedRows.map((p) => ({
            id: p.id,
            name: p.name,
            type: p.type,
            url: p.url,
            username: p.username,
            password: p.password,
            is_active: p.is_active,
            created_at: p.created_at,
          }));
        }
      }
    }

    const currentStatus = calculateDeviceStatus(device);

    const responsePayload = {
      mac_address: device.mac_address,
      device_key: device.device_key,
      status: currentStatus.status,
      is_valid: currentStatus.is_valid,
      days_remaining: currentStatus.days_remaining,
      trial_ends_at: device.trial_ends_at,
      license_expires_at: device.license_expires_at,
      device_type: device.device_type,
      playlists: currentStatus.is_valid ? playlists : [],
    };

    // Protocol v3: mandatory per-session ECDH key agreement + ECDSA P-256 server signature.
    // Plain debug output and static-key fallbacks are disabled so responses cannot be downgraded.
    try {
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
    } catch (pairError) {
      console.error('ECDH pairing rejected:', pairError);
      return NextResponse.json(
        {
          success: false,
          error: 'تعذر إتمام مصافحة الجهاز بأمان، يرجى المحاولة لاحقاً.',
        },
        { status: 500 },
      );
    }
  } catch (error) {
    console.error('Unhandled error in device handshake:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'حدث خطأ داخلي في الخادم أثناء مصافحة الجهاز.',
      },
      { status: 500 },
    );
  }
}
