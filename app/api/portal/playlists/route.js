import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { authenticatePortalRequest } from '@/lib/portal-auth';
import { encryptPassword, decryptPassword } from '@/lib/iptv-crypto';
import {
  resolveAndParsePlaylistInput,
  normalizeAndMigratePlaylistRow,
} from '@/lib/xtream-parser';

/**
 * GET /api/portal/playlists
 * Fetches all playlists for the authenticated device
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

    const url = new URL(request.url);
    const activeOnly = url.searchParams.get('active_only') === 'true';

    let query = supabase
      .from('playlists')
      .select('*')
      .eq('device_id', device.id)
      .order('id', { ascending: true });

    if (activeOnly) {
      query = query.eq('is_active', true);
    }

    const { data: playlists, error } = await query;

    if (error) {
      console.error('Database error fetching playlists:', error);
      return NextResponse.json(
        { success: false, error: 'تعذر جلب قوائم التشغيل من قاعدة البيانات.' },
        { status: 500 },
      );
    }

    const formatted = await Promise.all(
      (playlists || []).map((p) => normalizeAndMigratePlaylistRow(supabase, p)),
    );

    return NextResponse.json({
      success: true,
      playlists: formatted,
      count: formatted.length,
    });
  } catch (error) {
    console.error('Unhandled error in get playlists:', error);
    return NextResponse.json(
      { success: false, error: 'حدث خطأ داخلي أثناء جلب قوائم التشغيل.' },
      { status: 500 },
    );
  }
}

/**
 * POST /api/portal/playlists
 * Adds a new playlist for the authenticated device.
 * Server extracts Xtream credentials if present and stores as 'xtream' in DB;
 * otherwise stores as direct 'm3u' link in DB.
 */
export async function POST(request) {
  try {
    const device = await authenticatePortalRequest(request);
    if (!device) {
      return NextResponse.json(
        { success: false, error: 'غير مصرح، يرجى تسجيل الدخول أولاً.' },
        { status: 401 },
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

    const { name, type, url, username, password } = body;

    if (typeof name !== 'string' || !name.trim()) {
      return NextResponse.json(
        { success: false, error: 'اسم الباقة name مطلوب.' },
        { status: 400 },
      );
    }

    const cleanType = String(type || 'm3u').trim().toLowerCase();
    if (cleanType !== 'm3u' && cleanType !== 'xtream') {
      return NextResponse.json(
        {
          success: false,
          error: "نوع القائمة type يجب أن يكون 'm3u' أو 'xtream'.",
        },
        { status: 400 },
      );
    }

    if (typeof url !== 'string' || !url.trim()) {
      return NextResponse.json(
        { success: false, error: 'رابط القائمة url مطلوب.' },
        { status: 400 },
      );
    }

    const cleanUrl = url.trim();
    if (!/^https?:\/\//i.test(cleanUrl)) {
      return NextResponse.json(
        {
          success: false,
          error: 'الرابط يجب أن يبدأ بـ http:// أو https://.',
        },
        { status: 400 },
      );
    }

    // Extract Xtream credentials on the server (including shortened URLs)
    const parsed = await resolveAndParsePlaylistInput({
      url: cleanUrl,
      username: cleanType === 'xtream' ? username : null,
      password: cleanType === 'xtream' ? password : null,
    });

    if (cleanType === 'xtream' && !parsed.isXtream) {
      return NextResponse.json(
        {
          success: false,
          error: 'اسم المستخدم وكلمة المرور مطلوبان لحسابات إكستريم (Xtream).',
        },
        { status: 400 },
      );
    }

    const newRecord = {
      device_id: device.id,
      name: name.trim().slice(0, 100),
      type: parsed.isXtream ? 'xtream' : 'm3u',
      url: parsed.url,
      username: parsed.isXtream ? parsed.username : null,
      password: parsed.isXtream ? encryptPassword(parsed.password) : null,
      is_active: true,
    };

    const { data: created, error: insertError } = await supabase
      .from('playlists')
      .insert(newRecord)
      .select('*')
      .single();

    if (insertError) {
      console.error('Database error creating playlist:', insertError);
      return NextResponse.json(
        { success: false, error: 'تعذر حفظ قائمة التشغيل في قاعدة البيانات.' },
        { status: 500 },
      );
    }

    return NextResponse.json({
      success: true,
      message: 'تمت إضافة القائمة بنجاح.',
      playlist: {
        id: created.id,
        device_id: created.device_id,
        name: created.name,
        type: created.type,
        url: created.url,
        username: created.username,
        is_active: created.is_active,
        created_at: created.created_at,
      },
    });
  } catch (error) {
    console.error('Unhandled error in create playlist:', error);
    return NextResponse.json(
      { success: false, error: 'حدث خطأ غير متوقع أثناء إضافة القائمة.' },
      { status: 500 },
    );
  }
}

/**
 * PUT /api/portal/playlists
 * Updates an existing playlist and persists the resolved type ('xtream' or 'm3u') in DB.
 */
export async function PUT(request) {
  try {
    const device = await authenticatePortalRequest(request);
    if (!device) {
      return NextResponse.json(
        { success: false, error: 'غير مصرح، يرجى تسجيل الدخول أولاً.' },
        { status: 401 },
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

    const { id, name, type, url, username, password, is_active } = body;

    if (!id) {
      return NextResponse.json(
        { success: false, error: 'معرف القائمة id مطلوب للتعديل.' },
        { status: 400 },
      );
    }

    const { data: existing, error: findError } = await supabase
      .from('playlists')
      .select('*')
      .eq('id', id)
      .eq('device_id', device.id)
      .maybeSingle();

    if (findError || !existing) {
      return NextResponse.json(
        { success: false, error: 'القائمة غير موجودة أو لا تنتمي لهذا الجهاز.' },
        { status: 404 },
      );
    }

    const updateFields = {
      updated_at: new Date().toISOString(),
    };

    if (name && typeof name === 'string' && name.trim()) {
      updateFields.name = name.trim().slice(0, 100);
    }

    if (typeof is_active === 'boolean') {
      updateFields.is_active = is_active;
    }

    const isUpdatingConnection =
      url !== undefined || type !== undefined || username !== undefined || password !== undefined;

    if (isUpdatingConnection) {
      const requestedType =
        typeof type === 'string' && type.trim()
          ? type.trim().toLowerCase()
          : existing.type;
      const candidateUrl =
        typeof url === 'string' && url.trim() ? url.trim() : existing.url;
      const existingPlainPass = existing.password ? decryptPassword(existing.password) : null;

      const candidateUser =
        requestedType === 'm3u'
          ? null
          : username !== undefined
            ? username
            : existing.username;
      const candidatePass =
        requestedType === 'm3u'
          ? null
          : password !== undefined && password !== null && password !== ''
            ? password
            : existingPlainPass;

      const parsed = await resolveAndParsePlaylistInput({
        url: candidateUrl,
        username: candidateUser,
        password: candidatePass,
      });

      if (requestedType === 'xtream' && !parsed.isXtream) {
        return NextResponse.json(
          {
            success: false,
            error: 'اسم المستخدم وكلمة المرور مطلوبان لحسابات إكستريم (Xtream).',
          },
          { status: 400 },
        );
      }

      updateFields.type = parsed.isXtream ? 'xtream' : 'm3u';
      updateFields.url = parsed.url;
      updateFields.username = parsed.isXtream ? parsed.username : null;
      updateFields.password = parsed.isXtream ? encryptPassword(parsed.password) : null;
    }

    const { data: updated, error: updateError } = await supabase
      .from('playlists')
      .update(updateFields)
      .eq('id', id)
      .eq('device_id', device.id)
      .select('*')
      .single();

    if (updateError) {
      console.error('Database error updating playlist:', updateError);
      return NextResponse.json(
        { success: false, error: 'تعذر تعديل بيانات القائمة.' },
        { status: 500 },
      );
    }

    return NextResponse.json({
      success: true,
      message: 'تم تعديل القائمة بنجاح.',
      playlist: {
        id: updated.id,
        name: updated.name,
        type: updated.type,
        url: updated.url,
        username: updated.username,
        is_active: updated.is_active,
        updated_at: updated.updated_at,
      },
    });
  } catch (error) {
    console.error('Unhandled error in update playlist:', error);
    return NextResponse.json(
      { success: false, error: 'حدث خطأ غير متوقع أثناء تعديل القائمة.' },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/portal/playlists
 * Deletes a playlist
 */
export async function DELETE(request) {
  try {
    const device = await authenticatePortalRequest(request);
    if (!device) {
      return NextResponse.json(
        { success: false, error: 'غير مصرح، يرجى تسجيل الدخول أولاً.' },
        { status: 401 },
      );
    }

    let id = null;
    const url = new URL(request.url);
    const paramId = url.searchParams.get('id');

    if (paramId) {
      id = paramId;
    } else {
      try {
        const body = await request.json();
        if (body && body.id) {
          id = body.id;
        }
      } catch {
        // Body was empty or not json
      }
    }

    if (!id) {
      return NextResponse.json(
        { success: false, error: 'معرف القائمة id مطلوب للحذف.' },
        { status: 400 },
      );
    }

    const { error: deleteError } = await supabase
      .from('playlists')
      .delete()
      .eq('id', id)
      .eq('device_id', device.id);

    if (deleteError) {
      console.error('Database error deleting playlist:', deleteError);
      return NextResponse.json(
        { success: false, error: 'تعذر حذف القائمة من قاعدة البيانات.' },
        { status: 500 },
      );
    }

    return NextResponse.json({
      success: true,
      message: 'تم حذف القائمة بنجاح.',
    });
  } catch (error) {
    console.error('Unhandled error in delete playlist:', error);
    return NextResponse.json(
      { success: false, error: 'حدث خطأ غير متوقع أثناء حذف القائمة.' },
      { status: 500 },
    );
  }
}
