export const dynamic = 'force-dynamic';

/**
 * Where the WhatsApp invite sends patients: how to get the CareLoop app and
 * sign in. The Android download appears when PATIENT_APP_ANDROID_URL is set.
 */
export default function GetTheApp() {
  const android = process.env.PATIENT_APP_ANDROID_URL;
  return (
    <main className="mx-auto max-w-md space-y-5 px-4 py-10">
      <h1 className="text-2xl font-semibold">CareLoop</h1>
      <p>
        Your clinic asked CareLoop to help you book a follow-up. Get the app, then sign in with the
        WhatsApp number your lab has for you. We send you a code on WhatsApp.
      </p>
      <p lang="hi">
        आपके क्लिनिक ने CareLoop से फ़ॉलो-अप बुक करने में मदद करने को कहा है। ऐप लें और उसी WhatsApp नंबर से साइन
        इन करें जो आपकी लैब के पास है। हम WhatsApp पर कोड भेजेंगे।
      </p>
      {android ? (
        <a
          href={android}
          className="inline-block rounded-md bg-teal-700 px-4 py-2 font-medium text-white"
        >
          Download for Android
        </a>
      ) : (
        <p className="rounded-md border p-3 text-sm">
          The app is in testing. Ask the lab for the install link.
        </p>
      )}
      <p className="text-sm opacity-75">
        CareLoop helps with booking only. It does not give medical advice. For medical questions,
        call your doctor or lab.
      </p>
    </main>
  );
}
