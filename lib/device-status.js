/**
 * Computes the real-time status and remaining days for an IPTV device
 */
export function calculateDeviceStatus(device) {
  const now = new Date();
  let effectiveStatus = 'expired';
  let daysRemaining = 0;
  let isValid = false;

  const licenseExp = device.license_expires_at
    ? new Date(device.license_expires_at)
    : null;
  const trialExp = device.trial_ends_at ? new Date(device.trial_ends_at) : null;

  if (licenseExp && licenseExp.getTime() > now.getTime()) {
    effectiveStatus = 'active';
    const diffMs = licenseExp.getTime() - now.getTime();
    daysRemaining = Math.max(
      1,
      Math.ceil(diffMs / (1000 * 60 * 60 * 24)),
    );
    isValid = true;
  } else if (trialExp && trialExp.getTime() > now.getTime()) {
    effectiveStatus = 'trial';
    const diffMs = trialExp.getTime() - now.getTime();
    daysRemaining = Math.max(
      1,
      Math.ceil(diffMs / (1000 * 60 * 60 * 24)),
    );
    isValid = true;
  } else {
    effectiveStatus = 'expired';
    daysRemaining = 0;
    isValid = false;
  }

  return {
    status: effectiveStatus,
    days_remaining: daysRemaining,
    is_valid: isValid,
    trial_ends_at: device.trial_ends_at,
    license_expires_at: device.license_expires_at,
  };
}
