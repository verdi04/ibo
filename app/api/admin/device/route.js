import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { verifyAdminRequest } from '@/lib/portal-auth';
import { normalizeMac } from '@/lib/iptv-crypto';
import { calculateDeviceStatus } from '@/lib/device-status';

/**
 * GET /api/admin/device?mac=...
 * Seller-side lookup used before extending a subscription. Returns entitlement fields only:
 * the device key and any playlist credentials stay server-side.
 */
export async function GET(request) {
  try {
    if (!verifyAdminRequest(request)) {
      return NextResponse.json(
        { success: false, error: 'هذه اللوحة مخصصة لحساب البائع.' },
        { status: 403 },
      );
    }

    const url = new URL(request.url);
    const normalizedMac = normalizeMac(url.searchParams.get('mac'));
    if (!normalizedMac) {
      return NextResponse.json(
        {
          success: false,
          error:
            'عنوان الماك mac غير صالح. يرجى التأكد من الصيغة (مثال: 00:1A:2B:3C:4D:5E).',
        },
        { status: 400 },
      );
    }

    const { data: device, error: selectError } = await supabase
      .from('devices')
      .select('*')
      .eq('mac_address', normalizedMac)
      .maybeSingle();

    if (selectError) {
      console.error('Database error in admin device lookup:', selectError);
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

    const { data: playlists, error: playlistError } = await supabase
      .from('playlists')
      .select('id, is_active')
      .eq('device_id', device.id);

    if (playlistError) {
      console.error('Database error counting playlists for admin lookup:', playlistError);
    }

    const statusInfo = calculateDeviceStatus(device);
    const activeCount = (playlists || []).filter((p) => p.is_active).length;

    return NextResponse.json({
      success: true,
      device: {
        id: device.id,
        mac_address: device.mac_address,
        status: statusInfo.status,
        is_valid: statusInfo.is_valid,
        days_remaining: statusInfo.days_remaining,
        trial_ends_at: device.trial_ends_at,
        license_expires_at: device.license_expires_at,
        device_type: device.device_type,
        last_seen_at: device.last_seen_at,
        playlists_total: (playlists || []).length,
        playlists_active: activeCount,
      },
    });
  } catch (error) {
    console.error('Unhandled error in admin device lookup:', error);
    return NextResponse.json(
      { success: false, error: 'حدث خطأ داخلي أثناء جلب بيانات الجهاز.' },
      { status: 500 },
    );
  }
}
