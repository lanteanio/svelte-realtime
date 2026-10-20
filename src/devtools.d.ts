export interface DevtoolsPresentation {
 /** Number and timestamp locale; also the label and relative-age locale when messages are supplied. Defaults to the browser locale. */
 locale?: string;
 /** Defaults to ltr without translated messages, otherwise the locale's reading direction. */
 direction?: 'ltr' | 'rtl';
 /** English label or message template to translated text. */
 messages?: Record<string, string>;
}
/** Configure development overlay presentation without affecting realtime data. */
export function configureDevtools(options?: DevtoolsPresentation): void;
