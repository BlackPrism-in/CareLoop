import 'package:careloop_patient/main.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('signed-out start shows WhatsApp sign-in', (tester) async {
    await tester.pumpWidget(const CareLoopApp(signedIn: false));
    expect(find.text('Send code on WhatsApp'), findsOneWidget);
    expect(find.text('+91 '), findsOneWidget);
  });
}
