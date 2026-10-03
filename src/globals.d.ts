// Things the pages get from script tags and CDNs rather than from imports.

// Meta's Facebook JS SDK (loaded by the onboarding page).
declare const FB: {
  init(options: { appId: string; cookie: boolean; xfbml: boolean; version: string }): void;
  login(callback: (response: { authResponse?: { code?: string } }) => void, options: Record<string, unknown>): void;
};

interface Window {
  fbAsyncInit?: () => void;
  // intl-tel-input, loaded by a script tag on the dashboard.
  intlTelInput(input: HTMLInputElement, options: Record<string, unknown>): {
    isValidNumber(): boolean;
    getNumber(): string;
    setNumber(number: string): void;
  };
}

declare module 'https://cdn.jsdelivr.net/*';
