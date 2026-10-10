export interface DevtoolsPresentation {
 /** Locale used by Intl formatters. Defaults to the browser locale. */
 locale?: string;
 /** Defaults to the locale's reading direction. */
 direction?: 'ltr' | 'rtl';
 /** English label or message template to translated text. */
 messages?: Record<string, string>;
}
/** Configure development overlay presentation without affecting realtime data. */
export function configureDevtools(options?: DevtoolsPresentation): void;
