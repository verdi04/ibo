import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { verifyAdminRequest } from '@/lib/portal-auth';
import { normalizeMac } from '@/lib/iptv-crypto';
import { calculateDeviceStatus } from '@/lib/device-status';

const MAX_MONTHS_PER_REQUEST = 60;
const MAX_DAYS_PER_REQUEST = 1825;

/**
 * POST /api/admin/activate
 * Grants subscription time. Requires a seller session: holding a device key proves ownership
 * of the device, not that anyone paid for it.
 */
export async function POST(request) {
  try {
    if (!verifyAdminRequest(request)) {
      return NextResponse.json(
        {
          success: false,
          error:
            'التفعيل حق حصري لحساب البائع بعد تأكيد الدفع. مفتاح الجهاز وحده لا يمنح صلاحية الاشتراك.',
        },
        { status: 403 },
      );
    }

    let body = {};
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { success: false, error: 'صيغة البيانات غير صحيحة، يرجى إرسال JSON صالح.' },
        { status: 400 },
      );
    }

    const targetMac = normalizeMac(body.mac_address);
    const targetId =
      Number.isInteger(body.device_id) && body.device_id > 0 ? body.device_id : null;

    if (!targetMac && !targetId) {
      return NextResponse.json(
        { success: false, error: 'حدد الجهاز المطلوب بتسجيل mac_address أو device_id.' },
        { status: 400 },
      );
    }

    let lookup = supabase.from('devices').select('*');
    lookup = targetMac ? lookup.eq('mac_address', targetMac) : lookup.eq('id', targetId);

    const { data: device, error: selectError } = await lookup.maybeSingle();

    if (selectError) {
      console.error('Database error finding device to activate:', selectError);
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

    const now = new Date();

    let monthsToAdd = 12;
    if (typeof body.months === 'number' && body.months > 0) {
      monthsToAdd = Math.min(MAX_MONTHS_PER_REQUEST, Math.floor(body.months));
    }

    let daysToAdd = null;
    if (typeof body.days === 'number' && body.days > 0) {
      daysToAdd = Math.min(MAX_DAYS_PER_REQUEST, Math.floor(body.days));
    }

    // Extend from the current expiry when the device still has time left
    let baseDate = now;
    if (device.license_expires_at) {
      const currentLicenseExp = new Date(device.license_expires_at);
      if (currentLicenseExp.getTime() > now.getTime()) {
        baseDate = currentLicenseExp;
      }
    }

    const newExpiresDate = new Date(baseDate.getTime());
    if (daysToAdd !== null) {
      newExpiresDate.setDate(newExpiresDate.getDate() + daysToAdd);
    } else {
      newExpiresDate.setMonth(newExpiresDate.getMonth() + monthsToAdd);
    }

    const newExpiresIso = newExpiresDate.toISOString();

    const { data: updatedDevice, error: updateError } = await supabase
      .from('devices')
      .update({
        status: 'active',
        license_expires_at: newExpiresIso,
        updated_at: now.toISOString(),
      })
      .eq('id', device.id)
      .select('*')
      .single();

    if (updateError) {
      console.error('Database error activating device:', updateError);
      return NextResponse.json(
        { success: false, error: 'حدث خطأ أثناء تفعيل الجهاز في قاعدة البيانات.' },
        { status: 500 },
      );
    }

    const currentStatus = calculateDeviceStatus(updatedDevice);

    return NextResponse.json({
      success: true,
      message: 'تم تفعيل الجهاز وتمديد الاشتراك بنجاح.',
      mac_address: updatedDevice.mac_address,
      status: currentStatus.status,
      license_expires_at: updatedDevice.license_expires_at,
      days_remaining: currentStatus.days_remaining,
    });
  } catch (error) {
    console.error('Unhandled error activating device:', error);
    return NextResponse.json(
      { success: false, error: 'حدث خطأ غير متوقع أثناء تفعيل الجهاز.' },
      { status: 500 },
    );
  }
}
