import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { authenticatePortalRequest } from '@/lib/portal-auth';
import { normalizeMac } from '@/lib/iptv-crypto';
import { calculateDeviceStatus } from '@/lib/device-status';

export async function POST(request) {
  try {
    let body = {};
    try {
      body = await request.json();
    } catch {
      // Body may be empty if called with only auth headers
    }

    let device = await authenticatePortalRequest(request);

    // If not authenticated via token/headers, try credentials in body
    if (!device && body && body.mac_address && body.device_key) {
      const normalizedMac = normalizeMac(body.mac_address);
      if (normalizedMac) {
        const { data: found } = await supabase
          .from('devices')
          .select('*')
          .eq('mac_address', normalizedMac)
          .eq('device_key', String(body.device_key).trim())
          .maybeSingle();

        if (found) {
          device = found;
        }
      }
    }

    if (!device) {
      return NextResponse.json(
        {
          success: false,
          error: 'غير مصرح، يرجى تسجيل الدخول أو إرسال عنوان MAC ومفتاح الجهاز الصحيحين.',
        },
        { status: 401 },
      );
    }

    const now = new Date();

    // Determine duration to extend: default 12 months (1 year)
    let monthsToAdd = 12;
    if (typeof body.months === 'number' && body.months > 0) {
      monthsToAdd = Math.min(60, Math.floor(body.months)); // max 5 years at once
    }

    let daysToAdd = null;
    if (typeof body.days === 'number' && body.days > 0) {
      daysToAdd = Math.min(1825, Math.floor(body.days));
    }

    // Determine baseline date: if device already has active license in the future, extend from it
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

    // Update device record in database
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
      status: currentStatus.status,
      license_expires_at: updatedDevice.license_expires_at,
      days_remaining: currentStatus.days_remaining,
      device: {
        id: updatedDevice.id,
        mac_address: updatedDevice.mac_address,
        device_key: updatedDevice.device_key,
        status: currentStatus.status,
        license_expires_at: updatedDevice.license_expires_at,
        days_remaining: currentStatus.days_remaining,
      },
    });
  } catch (error) {
    console.error('Unhandled error activating device:', error);
    return NextResponse.json(
      { success: false, error: 'حدث خطأ غير متوقع أثناء تفعيل الجهاز.' },
      { status: 500 },
    );
  }
}
