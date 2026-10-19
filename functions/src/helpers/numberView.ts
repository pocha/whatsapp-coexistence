import { effectiveStep } from './onboardingSteps';
import { limitsView, UNITS } from './rateLimiter';
import { effectiveConfigFor } from './health';
import { counts, statusOf } from './gates';
import type { NumberView, PhoneNumberDoc, RelayLimitsResponse } from './types';

/** The status as it stands now: a reason with an end time that has passed no longer counts. */
export function presentHealth(health: NonNullable<PhoneNumberDoc['health']>, now: number) {
  const reasons = health.reasons.filter((r) => counts(r, now));
  return { ...health, reasons, status: statusOf(reasons, now) };
}

/**
 * What a caller may see of a number: listed field by field, so a field added to the record later
 * stays private until someone adds it here. Never the stored token, only whether there is one.
 */
export function numberView(doc: PhoneNumberDoc): NumberView {
  return {
    phoneNumberId: doc.phoneNumberId,
    wabaId: doc.wabaId,
    displayPhoneNumber: doc.displayPhoneNumber,
    overrideUrl: doc.overrideUrl,
    callbackSkipped: doc.callbackSkipped,
    health: doc.health && presentHealth(doc.health, Date.now()),
    displayName: doc.displayName,
    templates: doc.templates,
    metaFetchedAt: doc.metaFetchedAt,
    activatedAt: doc.activatedAt,
    lastRelayCall: doc.lastRelayCall,
    usage: doc.usage,
    rateState: doc.rateState,
    rateLimits: doc.rateLimits,
    onboarding: doc.onboarding,
    step: effectiveStep(doc),
    hasToken: Boolean(doc.encAccessToken),
    isOnBizApp: doc.isOnBizApp,
    platformType: doc.platformType,
    metaStatus: doc.metaStatus,
    sync: doc.sync,
  };
}

/** Where the number stands against its template-send limits: per window, what went through and when it resets. */
export function relayLimits(doc: PhoneNumberDoc, now: number): RelayLimitsResponse {
  const config = effectiveConfigFor(doc);
  const windows = limitsView(doc.rateState, config, now);
  return {
    ok: true,
    appliesTo: 'template messages',
    enabled: config.enabled,
    windows: Object.fromEntries(
      UNITS.map((unit) => [
        unit,
        { ...windows[unit], resetsAt: new Date(windows[unit].resetsAt).toISOString(), resetsInSeconds: Math.max(1, Math.ceil((windows[unit].resetsAt - now) / 1000)) },
      ]),
    ) as RelayLimitsResponse['windows'],
  };
}
