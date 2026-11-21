import type { SupportedLanguage } from '@careloop/contracts';

/**
 * WhatsApp Cloud API (Meta) for patient messages. Only pre-approved templates
 * are sent, never free text, and no template carries health details beyond the
 * kind of follow-up. Outside the pilot, messages go ONLY to allow-listed test
 * numbers (testers' own phones linked to synthetic patients); anything else is
 * recorded as simulated and not sent.
 */
export type PatientTemplate =
  'LOGIN_CODE' | 'FOLLOWUP_INVITE' | 'BOOKING_CONFIRMED' | 'VISIT_REMINDER';

export interface TemplateDef {
  /** Name registered with Meta. */
  name: string;
  category: 'AUTHENTICATION' | 'UTILITY';
  /** Body text per Meta language code ({{n}} placeholders); AUTHENTICATION bodies are fixed by Meta. */
  body: Partial<Record<'en' | 'hi', string>>;
  /** Example values for template review, one per placeholder. */
  examples: string[];
  /** Languages registered with Meta (default en + hi). Others fall back to English. */
  languages?: readonly ('en' | 'hi')[];
  /** Static link button (no parameters at send time); its URL is set when the template is submitted. */
  urlButton?: Record<'en' | 'hi', string>;
}

export const PATIENT_TEMPLATES: Record<PatientTemplate, TemplateDef> = {
  LOGIN_CODE: {
    name: 'careloop_login_code',
    category: 'AUTHENTICATION',
    body: {},
    examples: ['482913'],
  },
  FOLLOWUP_INVITE: {
    // v1 ("careloop_followup_invite") was rejected by Meta as INCORRECT_CATEGORY:
    // it read as an app promotion. This one is about the specific ordered follow-up.
    name: 'careloop_followup_due',
    category: 'UTILITY',
    body: {
      en: 'Follow-up reminder from {{1}}: your {{2}} is due by {{3}}. Please choose an appointment time, or ask the lab to call you. Sign in with this WhatsApp number.',
      hi: 'फ़ॉलो-अप सूचना ({{1}}): आपकी {{2}} {{3}} तक होनी है। कृपया अपॉइंटमेंट का समय चुनें या लैब से कॉल का अनुरोध करें। इसी WhatsApp नंबर से साइन इन करें।',
    },
    examples: ['Demo Diagnostics', 'consultation', '28 Nov'],
    // Meta filed the Hindi version as MARKETING (paid); it was deleted. English only.
    languages: ['en'],
    urlButton: { en: 'Choose a time', hi: 'समय चुनें' },
  },
  BOOKING_CONFIRMED: {
    name: 'careloop_booking_confirmed',
    category: 'UTILITY',
    body: {
      en: 'Your {{1}} at {{2}} is booked for {{3}} at {{4}}. You can see or change it in the CareLoop app.',
      hi: 'आपकी {{1}} {{2}} में {{3}} को {{4}} बजे बुक हो गई है। आप इसे CareLoop ऐप में देख या बदल सकते हैं।',
    },
    examples: ['consultation', 'Demo Clinic', 'Sat 28 Nov', '4:30 pm'],
  },
  VISIT_REMINDER: {
    name: 'careloop_visit_reminder',
    category: 'UTILITY',
    body: {
      en: 'Reminder: your {{1}} at {{2}} is tomorrow, {{3}} at {{4}}. To change it, open the CareLoop app.',
      hi: 'याद दिलाना: आपकी {{1}} {{2}} में कल, {{3}} को {{4}} बजे है। बदलने के लिए CareLoop ऐप खोलें।',
    },
    examples: ['consultation', 'Demo Clinic', 'Sat 28 Nov', '4:30 pm'],
  },
};

/** Meta template language for a patient language. Bengali falls back to English until reviewed. */
export function templateLanguage(l: SupportedLanguage): 'en' | 'hi' {
  return l === 'hi-IN' ? 'hi' : 'en';
}

/** The template language actually registered for this template. */
export function templateLanguageFor(def: TemplateDef, l: SupportedLanguage): 'en' | 'hi' {
  const want = templateLanguage(l);
  return (def.languages ?? ['en', 'hi']).includes(want) ? want : 'en';
}

/** Words for the follow-up kind inside templates. */
export function followUpWord(kind: 'CONSULTATION' | 'ORDERED_TEST', l: SupportedLanguage): string {
  if (templateLanguage(l) === 'hi') return kind === 'CONSULTATION' ? 'परामर्श' : 'जाँच';
  return kind === 'CONSULTATION' ? 'consultation' : 'test';
}

export interface WhatsAppConfig {
  mode: 'simulated' | 'whatsapp';
  appEnv: string;
  phoneNumberId?: string;
  accessToken?: string;
  graphVersion: string;
  testRecipients: string[];
  /** Approved authentication template to use when careloop_login_code is not usable yet. */
  loginFallbackTemplate?: string;
}

export interface SendResult {
  status: 'SENT' | 'SIMULATED' | 'FAILED';
  providerRef?: string;
  /** Why it was not sent (simulated) or what failed. Never contains the message or code. */
  reason?: string;
}

export const E164 = /^\+[1-9]\d{7,14}$/;

/** "+91 •••••• 0101": what staff screens and logs show. */
export function maskPhone(e164: string): string {
  return `${e164.slice(0, 3)} •••••• ${e164.slice(-4)}`;
}

export class WhatsAppSender {
  constructor(
    private readonly cfg: WhatsAppConfig,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  get live(): boolean {
    return this.cfg.mode === 'whatsapp';
  }

  /** Whether a real message may go to this number in this environment. */
  allowed(to: string): boolean {
    if (!this.live) return false;
    return this.cfg.appEnv === 'pilot' || this.cfg.testRecipients.includes(to);
  }

  async send(m: {
    to: string;
    template: PatientTemplate;
    language: SupportedLanguage;
    params: string[];
  }): Promise<SendResult> {
    const r = await this.sendOnce(m);
    // 132001: template missing or not approved (e.g. still in Meta review).
    if (
      r.status === 'FAILED' &&
      m.template === 'LOGIN_CODE' &&
      this.cfg.loginFallbackTemplate &&
      /^META_132001/.test(r.reason ?? '')
    )
      return this.sendOnce(m, { name: this.cfg.loginFallbackTemplate, language: 'en' });
    return r;
  }

  private async sendOnce(
    m: { to: string; template: PatientTemplate; language: SupportedLanguage; params: string[] },
    override?: { name: string; language: 'en' | 'hi' },
  ): Promise<SendResult> {
    if (!E164.test(m.to)) return { status: 'FAILED', reason: 'INVALID_NUMBER' };
    if (!this.live) return { status: 'SIMULATED', reason: 'MESSAGING_SIMULATED' };
    if (!this.allowed(m.to)) return { status: 'SIMULATED', reason: 'NOT_A_TEST_RECIPIENT' };
    const def = PATIENT_TEMPLATES[m.template];
    const text = (v: string) => ({ type: 'text', text: v });
    const components: unknown[] = [{ type: 'body', parameters: m.params.map(text) }];
    // Authentication templates carry the code again on their copy-code button.
    if (def.category === 'AUTHENTICATION')
      components.push({
        type: 'button',
        sub_type: 'url',
        index: '0',
        parameters: [text(m.params[0]!)],
      });
    try {
      const r = await this.fetchFn(
        `https://graph.facebook.com/${this.cfg.graphVersion}/${this.cfg.phoneNumberId}/messages`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.cfg.accessToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            to: m.to.slice(1),
            type: 'template',
            template: {
              name: override?.name ?? def.name,
              language: { code: override?.language ?? templateLanguageFor(def, m.language) },
              components,
            },
          }),
          signal: AbortSignal.timeout(10_000),
        },
      );
      const j = (await r.json().catch(() => ({}))) as {
        messages?: { id: string }[];
        error?: { code?: number; message?: string };
      };
      if (!r.ok || !j.messages?.[0])
        return {
          status: 'FAILED',
          reason: `META_${j.error?.code ?? r.status}: ${(j.error?.message ?? '').slice(0, 120)}`,
        };
      return { status: 'SENT', providerRef: j.messages[0].id };
    } catch (e) {
      return { status: 'FAILED', reason: `NETWORK: ${(e as Error).message.slice(0, 80)}` };
    }
  }
}

export function whatsAppSenderFor(cfg: {
  APP_ENV: string;
  MESSAGING_ADAPTER: string;
  WHATSAPP_PHONE_NUMBER_ID?: string;
  WHATSAPP_ACCESS_TOKEN?: string;
  WHATSAPP_GRAPH_VERSION: string;
  WHATSAPP_TEST_RECIPIENTS: string[];
  WHATSAPP_LOGIN_FALLBACK_TEMPLATE?: string;
}): WhatsAppSender {
  return new WhatsAppSender({
    mode: cfg.MESSAGING_ADAPTER === 'whatsapp' ? 'whatsapp' : 'simulated',
    appEnv: cfg.APP_ENV,
    phoneNumberId: cfg.WHATSAPP_PHONE_NUMBER_ID,
    accessToken: cfg.WHATSAPP_ACCESS_TOKEN,
    graphVersion: cfg.WHATSAPP_GRAPH_VERSION,
    testRecipients: cfg.WHATSAPP_TEST_RECIPIENTS,
    loginFallbackTemplate: cfg.WHATSAPP_LOGIN_FALLBACK_TEMPLATE,
  });
}
