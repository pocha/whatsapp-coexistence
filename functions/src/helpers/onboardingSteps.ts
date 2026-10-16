import type { OnboardingStep, PhoneNumberDoc } from './types';

/**
 * The step a number needs next, worked out from what its record says, so the dashboard can send
 * the user to the right place however the record got into this state (a de-register, a status
 * check, an unfinished onboarding). Used by the number page, the sidebar and the wizard.
 *
 * Template progress can't be read from the record, so that step (and the choice on the "not on the
 * app" screen) is kept as stored. A number with no recorded state about the Business app is an
 * older one: we don't know, so only its URL is checked.
 */
export function effectiveStep(doc: PhoneNumberDoc): OnboardingStep {
  const stored: OnboardingStep = doc.onboarding?.step ?? 'done';
  if (!doc.encAccessToken) return stored; // needs onboarding again, which is not a step

  if (!doc.overrideUrl) return 'override';

  // An API-only number that Meta no longer shows as connected has to be registered again.
  if (doc.isOnBizApp === false && doc.metaStatus && doc.metaStatus !== 'CONNECTED' && stored !== 'not_on_app') return 'register';

  // A coexistence number is not finished until both syncs have been requested.
  if (doc.isOnBizApp === true && doc.sync && !(doc.sync.contacts?.state === 'requested' && doc.sync.history?.state === 'requested')) {
    return 'sync';
  }
  return stored;
}
