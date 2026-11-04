import { NextResponse } from 'next/server';
import { authenticatePortalRequest } from '@/lib/portal-auth';
import { calculateDeviceStatus } from '@/lib/device-status';

/**
 * GET /api/portal/status
 * Re-reads the authenticated device's subscription so the portal can show a remaining-day
 * count and an expiry date that follow the database instead of the login snapshot.
 */
export async function GET(request) {
  try {
    const device = await authenticatePortalRequest(request);
    if (!device) {
      return NextResponse.json(
        { success: false, error: 'غير مصرح، يرجى تسجيل الدخول أولاً.' },
        { status: 401 },
      );
    }

    const statusInfo = calculateDeviceStatus(device);

    return NextResponse.json({
      success: true,
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
    console.error('Unhandled error fetching device status:', error);
    return NextResponse.json(
      { success: false, error: 'تعذر جلب حالة الاشتراك.' },
      { status: 500 },
    );
  }
}
