import 'package:flutter/widgets.dart';
import 'package:intl/intl.dart';

/// App languages: English, Hindi, Bengali. Each string is [en, hi, bn].
enum Lang { en, hi, bn }

extension LangX on Lang {
  String get label => const ['English', 'हिन्दी', 'বাংলা'][index];
  String get locale => const ['en_IN', 'hi_IN', 'bn_IN'][index];
  static Lang fromApi(String l) => l.startsWith('hi')
      ? Lang.hi
      : l.startsWith('bn')
      ? Lang.bn
      : Lang.en;
}

class S {
  S(this.lang);
  final Lang lang;
  String _t(List<String> v) => v[lang.index];

  static final current = ValueNotifier<Lang>(Lang.en);

  /// Registers [context] to rebuild when the language changes.
  static S of(BuildContext context) {
    context.dependOnInheritedWidgetOfExactType<LangScope>();
    return S(current.value);
  }

  String get appName => 'CareLoop';
  String get tagline => _t([
    'Book the follow-up your clinic asked for.',
    'अपने क्लिनिक की बताई फ़ॉलो-अप बुक करें।',
    'আপনার ক্লিনিকের বলা ফলো-আপ বুক করুন।',
  ]);
  String get phoneLabel =>
      _t(['WhatsApp number', 'WhatsApp नंबर', 'WhatsApp নম্বর']);
  String get phoneHint => _t([
    'The number your lab has for you',
    'वह नंबर जो आपकी लैब के पास है',
    'আপনার ল্যাবের কাছে থাকা নম্বর',
  ]);
  String get sendCode => _t([
    'Send code on WhatsApp',
    'WhatsApp पर कोड भेजें',
    'WhatsApp-এ কোড পাঠান',
  ]);
  String get enterCode => _t([
    'Enter the 6-digit code',
    '6 अंकों का कोड डालें',
    '৬ অঙ্কের কোড লিখুন',
  ]);
  String codeSentTo(String p) => _t([
    'If $p is registered with a lab, we sent a code to it on WhatsApp. It works for 10 minutes.',
    'अगर $p किसी लैब में दर्ज है, तो हमने उस पर WhatsApp से कोड भेजा है। यह 10 मिनट चलेगा।',
    '$p কোনো ল্যাবে নথিভুক্ত থাকলে, আমরা WhatsApp-এ কোড পাঠিয়েছি। এটি ১০ মিনিট চলবে।',
  ]);
  String get verify => _t(['Sign in', 'साइन इन करें', 'সাইন ইন']);
  String get resend =>
      _t(['Send a new code', 'नया कोड भेजें', 'নতুন কোড পাঠান']);
  String get changeNumber => _t(['Change number', 'नंबर बदलें', 'নম্বর বদলান']);
  String demoCode(String c) => _t([
    'Demo lab: WhatsApp is not connected for this number, so your code is $c',
    'डेमो लैब: इस नंबर के लिए WhatsApp जुड़ा नहीं है, आपका कोड $c है',
    'ডেমো ল্যাব: এই নম্বরে WhatsApp যুক্ত নেই, আপনার কোড $c',
  ]);
  String get myFollowUps =>
      _t(['My follow-ups', 'मेरी फ़ॉलो-अप', 'আমার ফলো-আপ']);
  String get none => _t([
    'Nothing to book right now. Your lab will message you on WhatsApp when there is.',
    'अभी बुक करने को कुछ नहीं है। ज़रूरत होने पर लैब आपको WhatsApp करेगी।',
    'এখন বুক করার কিছু নেই। দরকার হলে ল্যাব আপনাকে WhatsApp করবে।',
  ]);
  String get signOut => _t(['Sign out', 'साइन आउट', 'সাইন আউট']);
  String kind(String k) => k == 'ORDERED_TEST'
      ? _t([
          'Test your doctor ordered',
          'डॉक्टर द्वारा बताई गई जाँच',
          'ডাক্তারের দেওয়া পরীক্ষা',
        ])
      : _t(['Consultation', 'परामर्श', 'পরামর্শ']);
  String dueBy(String d) => _t(['Due by $d', '$d तक', '$d-এর মধ্যে']);
  String status(String s) => switch (s) {
    'BOOKED' => _t(['Booked', 'बुक हो गई', 'বুক হয়েছে']),
    'REQUEST_RECEIVED' => _t([
      'Request received',
      'अनुरोध मिला',
      'অনুরোধ পাওয়া গেছে',
    ]),
    'DONE' => _t(['Done', 'पूरी हुई', 'সম্পন্ন']),
    'CLOSED' => _t(['Closed', 'बंद', 'বন্ধ']),
    _ => _t(['Not booked yet', 'अभी बुक नहीं', 'এখনও বুক হয়নি']),
  };
  String get chooseTime => _t(['Choose a time', 'समय चुनें', 'সময় বেছে নিন']);
  String get noTimes => _t([
    'No times are free before the due date. Ask the lab to call you.',
    'तय तारीख से पहले कोई समय खाली नहीं है। लैब से कॉल का अनुरोध करें।',
    'নির্ধারিত তারিখের আগে কোনো সময় খালি নেই। ল্যাবকে ফোন করতে বলুন।',
  ]);
  String confirmBook(String when, String where) => _t([
    'Book $when at $where?',
    '$where में $when बुक करें?',
    '$where-এ $when বুক করবেন?',
  ]);
  String get book => _t(['Book', 'बुक करें', 'বুক করুন']);
  String get cancel => _t(['Cancel', 'रद्द करें', 'বাতিল']);
  String get bookingSent => _t([
    'Request sent. We will confirm once the lab’s calendar does, and message you on WhatsApp.',
    'अनुरोध भेजा गया। लैब के कैलेंडर की पुष्टि होते ही हम WhatsApp पर बताएँगे।',
    'অনুরোধ পাঠানো হয়েছে। ল্যাবের ক্যালেন্ডার নিশ্চিত করলে WhatsApp-এ জানাব।',
  ]);
  String get appointment =>
      _t(['Your appointment', 'आपकी अपॉइंटमेंट', 'আপনার অ্যাপয়েন্টমেন্ট']);
  String get labWillCall => _t([
    'The lab will call you.',
    'लैब आपको कॉल करेगी।',
    'ল্যাব আপনাকে ফোন করবে।',
  ]);
  String get askChange =>
      _t(['Ask for a different time', 'दूसरा समय माँगें', 'অন্য সময় চান']);
  String get askCall => _t([
    'Ask the lab to call me',
    'लैब मुझे कॉल करे',
    'ল্যাব আমাকে ফোন করুক',
  ]);
  String get stop => _t([
    'Stop automated messages',
    'स्वचालित संदेश बंद करें',
    'স্বয়ংক্রিয় বার্তা বন্ধ করুন',
  ]);
  String get stopConfirm => _t([
    'Stop automated calls and messages about this follow-up? The lab can still contact you itself.',
    'इस फ़ॉलो-अप के लिए स्वचालित कॉल और संदेश बंद करें? लैब फिर भी खुद संपर्क कर सकती है।',
    'এই ফলো-আপের স্বয়ংক্রিয় কল ও বার্তা বন্ধ করবেন? ল্যাব নিজে যোগাযোগ করতে পারবে।',
  ]);
  String get stopped => _t([
    'Automated contact is off for this follow-up.',
    'इस फ़ॉलो-अप के लिए स्वचालित संपर्क बंद है।',
    'এই ফলো-আপের স্বয়ংক্রিয় যোগাযোগ বন্ধ।',
  ]);
  String get requested => _t([
    'Done. Someone from the lab will call you. Your appointment stays as it is until then.',
    'हो गया। लैब से कोई आपको कॉल करेगा। तब तक आपकी अपॉइंटमेंट वैसी ही रहेगी।',
    'হয়েছে। ল্যাব থেকে কেউ ফোন করবে। ততক্ষণ অ্যাপয়েন্টমেন্ট যেমন আছে থাকবে।',
  ]);
  String get notMedical => _t([
    'CareLoop helps with booking only. For medical questions, call your doctor or lab.',
    'CareLoop सिर्फ़ बुकिंग में मदद करता है। चिकित्सा सवालों के लिए अपने डॉक्टर या लैब को कॉल करें।',
    'CareLoop শুধু বুকিংয়ে সাহায্য করে। চিকিৎসা-সংক্রান্ত প্রশ্নে ডাক্তার বা ল্যাবকে ফোন করুন।',
  ]);
  String get synthetic => _t([
    'Demo lab: synthetic data, nothing here is a real appointment.',
    'डेमो लैब: नकली डेटा, यहाँ कोई असली अपॉइंटमेंट नहीं है।',
    'ডেমো ল্যাব: কৃত্রিম ডেটা, এখানে কোনো আসল অ্যাপয়েন্টমেন্ট নেই।',
  ]);
  String get network => _t([
    'Could not reach CareLoop. Check your internet and try again.',
    'CareLoop से जुड़ नहीं सके। इंटरनेट देखें और फिर कोशिश करें।',
    'CareLoop-এ পৌঁছানো যায়নি। ইন্টারনেট দেখে আবার চেষ্টা করুন।',
  ]);
  String get retry => _t(['Try again', 'फिर कोशिश करें', 'আবার চেষ্টা']);

  String day(DateTime d) =>
      DateFormat('EEE d MMM', lang.locale).format(d.toLocal());
  String time(DateTime d) =>
      DateFormat('h:mm a', lang.locale).format(d.toLocal());
  String dayTime(DateTime d) => '${day(d)}, ${time(d)}';
}

/// Rebuilds every widget that read strings via [S.of] when the language changes.
class LangScope extends InheritedNotifier<ValueNotifier<Lang>> {
  LangScope({super.key, required super.child}) : super(notifier: S.current);
}
