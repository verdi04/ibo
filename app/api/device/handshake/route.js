import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import {
  normalizeMac,
  generateDeviceKey,
  encryptPayload,
  decryptPassword,
  deriveEcdhSessionKey,
} from '@/lib/iptv-crypto';
import { calculateDeviceStatus } from '@/lib/device-status';
import {
  getClientIp,
  checkEndpointRateLimit,
} from '@/lib/rate-limiter';

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

    const { mac_address, device_type } = body;

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

    const effectiveDeviceType =
      typeof device_type === 'string' && device_type.trim()
        ? device_type.trim().slice(0, 50)
        : 'Android TV';

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

    let device = existingDevice;
    let playlists = [];

    if (!device) {
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
      // Existing device: update last_seen_at and fetch active playlists
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

      // Fetch active playlists for this device
      const { data: dbPlaylists, error: playlistError } = await supabase
        .from('playlists')
        .select('*')
        .eq('device_id', device.id)
        .eq('is_active', true)
        .order('id', { ascending: true });

      if (playlistError) {
        console.error('Database error fetching playlists:', playlistError);
      } else if (dbPlaylists) {
        playlists = dbPlaylists.map((p) => ({
          id: p.id,
          name: p.name,
          type: p.type,
          url: p.url,
          username: p.username || null,
          password: p.password ? decryptPassword(p.password) : null,
          is_active: p.is_active,
          created_at: p.created_at,
        }));
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
      playlists,
    };

    // Check if plain debugging mode is requested
    const url = new URL(request.url);
    const allowPlain =
      process.env.NODE_ENV !== 'production' &&
      (url.searchParams.get('plain') === 'true' ||
        request.headers.get('x-plain-response') === 'true');

    if (allowPlain) {
      const encryptedPreview = encryptPayload(responsePayload);
      return NextResponse.json({
        success: true,
        encrypted: false,
        payload: responsePayload,
        encrypted_preview: encryptedPreview.combined,
      });
    }

    // Protocol v2: per-session ECDH key agreement when the client offers an ephemeral public point
    const clientPubKey =
      typeof body.client_pubkey === 'string' ? body.client_pubkey.trim() : '';

    if (clientPubKey) {
      try {
        const { aesKey, serverPublicKey } = deriveEcdhSessionKey(
          clientPubKey,
          normalizedMac,
        );
        const pairEncrypted = encryptPayload(responsePayload, aesKey);

        return NextResponse.json({
          success: true,
          encrypted: true,
          mode: 'pair',
          server_pubkey: serverPublicKey,
          payload: pairEncrypted.combined,
        });
      } catch (pairError) {
        console.error(
          'ECDH pairing failed, falling back to legacy static-key encryption:',
          pairError,
        );
      }
    }

    // Legacy path for already-installed APKs (static APP_SECRET_KEY)
    const encryptedResult = encryptPayload(responsePayload);

    return NextResponse.json({
      success: true,
      encrypted: true,
      payload: encryptedResult.combined,
      data: encryptedResult,
    });
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
