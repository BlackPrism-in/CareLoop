import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:intl/date_symbol_data_local.dart';

import 'api.dart';
import 'strings.dart';

final api = CareLoopApi();

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await Future.wait([
    initializeDateFormatting('en_IN'),
    initializeDateFormatting('hi_IN'),
    initializeDateFormatting('bn_IN'),
  ]);
  final signedIn = await api.restoreSession();
  runApp(CareLoopApp(signedIn: signedIn));
}

const _teal = Color(0xFF0F766E);

class CareLoopApp extends StatelessWidget {
  const CareLoopApp({super.key, required this.signedIn});
  final bool signedIn;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'CareLoop',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(colorSchemeSeed: _teal, useMaterial3: true),
      darkTheme: ThemeData(
        colorSchemeSeed: _teal,
        useMaterial3: true,
        brightness: Brightness.dark,
      ),
      builder: (_, child) => LangScope(child: child!),
      home: signedIn ? const HomeScreen() : const PhoneScreen(),
    );
  }
}

void _toast(BuildContext context, String msg) =>
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));

String _errorText(BuildContext context, Object e) =>
    e is ApiException && e.code == 'NETWORK'
    ? S.of(context).network
    : e.toString();

class LanguagePicker extends StatelessWidget {
  const LanguagePicker({super.key});
  @override
  Widget build(BuildContext context) => PopupMenuButton<Lang>(
    icon: const Icon(Icons.translate),
    initialValue: S.current.value,
    onSelected: (l) => S.current.value = l,
    itemBuilder: (_) => [
      for (final l in Lang.values)
        PopupMenuItem(value: l, child: Text(l.label)),
    ],
  );
}

// ---------------------------------------------------------------------------
// Sign in: WhatsApp number → code

class PhoneScreen extends StatefulWidget {
  const PhoneScreen({super.key});
  @override
  State<PhoneScreen> createState() => _PhoneScreenState();
}

class _PhoneScreenState extends State<PhoneScreen> {
  final _phone = TextEditingController();
  bool _busy = false;

  Future<void> _send() async {
    final digits = _phone.text.replaceAll(RegExp(r'\D'), '');
    if (digits.length != 10) return;
    final phone = '+91$digits';
    setState(() => _busy = true);
    try {
      final r = await api.startLogin(phone);
      if (!mounted) return;
      Navigator.of(context).push(
        MaterialPageRoute(
          builder: (_) => CodeScreen(phone: phone, start: r),
        ),
      );
    } catch (e) {
      if (mounted) _toast(context, _errorText(context, e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    return Scaffold(
      appBar: AppBar(actions: const [LanguagePicker()]),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(24),
          children: [
            Icon(
              Icons.event_available,
              size: 56,
              color: Theme.of(context).colorScheme.primary,
            ),
            const SizedBox(height: 16),
            Text(s.appName, style: Theme.of(context).textTheme.headlineMedium),
            const SizedBox(height: 8),
            Text(s.tagline, style: Theme.of(context).textTheme.bodyLarge),
            const SizedBox(height: 32),
            TextField(
              controller: _phone,
              keyboardType: TextInputType.phone,
              inputFormatters: [
                FilteringTextInputFormatter.digitsOnly,
                LengthLimitingTextInputFormatter(10),
              ],
              decoration: InputDecoration(
                labelText: s.phoneLabel,
                helperText: s.phoneHint,
                prefixText: '+91 ',
                border: const OutlineInputBorder(),
              ),
              onChanged: (_) => setState(() {}),
              onSubmitted: (_) => _send(),
            ),
            const SizedBox(height: 24),
            FilledButton.icon(
              onPressed: _busy || _phone.text.length != 10 ? null : _send,
              icon: _busy
                  ? const SizedBox.square(
                      dimension: 18,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.chat),
              label: Text(s.sendCode),
            ),
            const SizedBox(height: 32),
            Text(s.notMedical, style: Theme.of(context).textTheme.bodySmall),
          ],
        ),
      ),
    );
  }
}

class CodeScreen extends StatefulWidget {
  const CodeScreen({super.key, required this.phone, required this.start});
  final String phone;
  final StartResult start;
  @override
  State<CodeScreen> createState() => _CodeScreenState();
}

class _CodeScreenState extends State<CodeScreen> {
  final _code = TextEditingController();
  late StartResult _start = widget.start;
  bool _busy = false;

  Future<void> _verify() async {
    if (_code.text.length != 6) return;
    setState(() => _busy = true);
    try {
      await api.verifyLogin(widget.phone, _code.text);
      if (!mounted) return;
      Navigator.of(context).pushAndRemoveUntil(
        MaterialPageRoute(builder: (_) => const HomeScreen()),
        (_) => false,
      );
    } catch (e) {
      if (mounted) _toast(context, _errorText(context, e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _resend() async {
    try {
      final r = await api.startLogin(widget.phone);
      if (mounted) setState(() => _start = r);
    } catch (e) {
      if (mounted) _toast(context, _errorText(context, e));
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final masked =
        '+91 •••••• ${widget.phone.substring(widget.phone.length - 4)}';
    return Scaffold(
      appBar: AppBar(actions: const [LanguagePicker()]),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(24),
          children: [
            Text(s.enterCode, style: Theme.of(context).textTheme.headlineSmall),
            const SizedBox(height: 8),
            Text(s.codeSentTo(masked)),
            if (_start.simulatedCode != null) ...[
              const SizedBox(height: 16),
              Card(
                color: Theme.of(context).colorScheme.tertiaryContainer,
                child: Padding(
                  padding: const EdgeInsets.all(12),
                  child: Text(s.demoCode(_start.simulatedCode!)),
                ),
              ),
            ],
            const SizedBox(height: 24),
            TextField(
              controller: _code,
              autofocus: true,
              keyboardType: TextInputType.number,
              autofillHints: const [AutofillHints.oneTimeCode],
              inputFormatters: [
                FilteringTextInputFormatter.digitsOnly,
                LengthLimitingTextInputFormatter(6),
              ],
              style: const TextStyle(fontSize: 28, letterSpacing: 8),
              textAlign: TextAlign.center,
              decoration: const InputDecoration(
                border: OutlineInputBorder(),
                counterText: '',
              ),
              onChanged: (v) {
                setState(() {});
                if (v.length == 6) _verify();
              },
            ),
            const SizedBox(height: 24),
            FilledButton(
              onPressed: _busy || _code.text.length != 6 ? null : _verify,
              child: Text(s.verify),
            ),
            const SizedBox(height: 8),
            TextButton(onPressed: _resend, child: Text(s.resend)),
            TextButton(
              onPressed: () => Navigator.of(context).pop(),
              child: Text(s.changeNumber),
            ),
          ],
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Follow-ups

Future<void> _signedOut(BuildContext context) async {
  await api.signOutLocal();
  if (!context.mounted) return;
  Navigator.of(context).pushAndRemoveUntil(
    MaterialPageRoute(builder: (_) => const PhoneScreen()),
    (_) => false,
  );
}

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});
  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> with WidgetsBindingObserver {
  late Future<List<FollowUp>> _items = _load(first: true);

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  /// Back in the app (e.g. from WhatsApp): show the latest status.
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) _refresh();
  }

  Future<List<FollowUp>> _load({bool first = false}) async {
    try {
      final r = await api.followUps();
      if (first) S.current.value = LangX.fromApi(r.language);
      return r.followUps;
    } on ApiException catch (e) {
      if (e.signedOut && mounted) await _signedOut(context);
      rethrow;
    }
  }

  Future<void> _refresh() async {
    final f = _load();
    setState(() => _items = f);
    await f.catchError((_) => <FollowUp>[]);
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    return Scaffold(
      appBar: AppBar(
        title: Text(s.myFollowUps),
        actions: [
          const LanguagePicker(),
          IconButton(
            tooltip: s.signOut,
            icon: const Icon(Icons.logout),
            onPressed: () async {
              await api.signOut();
              if (context.mounted) await _signedOut(context);
            },
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: _refresh,
        child: FutureBuilder<List<FollowUp>>(
          future: _items,
          builder: (context, snap) {
            if (snap.connectionState != ConnectionState.done) {
              return const Center(child: CircularProgressIndicator());
            }
            if (snap.hasError) {
              return ListView(
                physics: const AlwaysScrollableScrollPhysics(),
                padding: const EdgeInsets.all(24),
                children: [
                  Text(_errorText(context, snap.error!)),
                  const SizedBox(height: 12),
                  OutlinedButton(onPressed: _refresh, child: Text(s.retry)),
                ],
              );
            }
            final items = snap.data!;
            return ListView(
              physics: const AlwaysScrollableScrollPhysics(),
              padding: const EdgeInsets.all(16),
              children: [
                if (items.any((f) => f.simulation))
                  _SyntheticBanner(text: s.synthetic),
                if (items.isEmpty)
                  Padding(
                    padding: const EdgeInsets.all(8),
                    child: Text(s.none),
                  ),
                for (final f in items)
                  Card(
                    child: ListTile(
                      title: Text(s.kind(f.followUp)),
                      subtitle: Text(
                        [
                          f.siteName ?? f.labName,
                          f.appointmentAt != null
                              ? s.dayTime(f.appointmentAt!)
                              : s.dueBy(s.day(f.dueAt)),
                        ].join('\n'),
                      ),
                      isThreeLine: true,
                      trailing: _StatusChip(status: f.status),
                      onTap: () => Navigator.of(context)
                          .push(
                            MaterialPageRoute(
                              builder: (_) => FollowUpScreen(refId: f.ref),
                            ),
                          )
                          .then((_) {
                            if (mounted) _refresh();
                          }),
                    ),
                  ),
                const SizedBox(height: 16),
                Text(
                  s.notMedical,
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ],
            );
          },
        ),
      ),
    );
  }
}

class _SyntheticBanner extends StatelessWidget {
  const _SyntheticBanner({required this.text});
  final String text;
  @override
  Widget build(BuildContext context) => Card(
    color: Theme.of(context).colorScheme.secondaryContainer,
    child: Padding(
      padding: const EdgeInsets.all(12),
      child: Row(
        children: [
          const Icon(Icons.science_outlined),
          const SizedBox(width: 8),
          Expanded(child: Text(text)),
        ],
      ),
    ),
  );
}

class _StatusChip extends StatelessWidget {
  const _StatusChip({required this.status});
  final String status;
  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    final (bg, fg) = switch (status) {
      'BOOKED' || 'DONE' => (cs.primaryContainer, cs.onPrimaryContainer),
      'REQUEST_RECEIVED' => (cs.tertiaryContainer, cs.onTertiaryContainer),
      _ => (cs.surfaceContainerHighest, cs.onSurface),
    };
    return Chip(
      label: Text(S.of(context).status(status), style: TextStyle(color: fg)),
      backgroundColor: bg,
      side: BorderSide.none,
    );
  }
}

class FollowUpScreen extends StatefulWidget {
  const FollowUpScreen({super.key, required this.refId});
  final String refId;
  @override
  State<FollowUpScreen> createState() => _FollowUpScreenState();
}

class _FollowUpScreenState extends State<FollowUpScreen> {
  FollowUp? _f;
  Object? _error;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final f = await api.followUp(widget.refId);
      if (mounted) {
        setState(() {
          _f = f;
          _error = null;
        });
      }
    } on ApiException catch (e) {
      if (e.signedOut && mounted) return _signedOut(context);
      if (mounted) setState(() => _error = e);
    }
  }

  Future<void> _do(Future<FollowUp> Function() fn, String done) async {
    setState(() => _busy = true);
    try {
      await fn();
      if (mounted) _toast(context, done);
      await _load();
    } catch (e) {
      if (mounted) _toast(context, _errorText(context, e));
      await _load();
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _book(Slot slot) async {
    final s = S.of(context);
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        content: Text(s.confirmBook(s.dayTime(slot.startsAt), slot.location)),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: Text(s.cancel),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: Text(s.book),
          ),
        ],
      ),
    );
    if (ok == true) {
      await _do(() => api.book(widget.refId, slot.slotId), s.bookingSent);
    }
  }

  Future<void> _stop() async {
    final s = S.of(context);
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        content: Text(s.stopConfirm),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: Text(s.cancel),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: Text(s.stop),
          ),
        ],
      ),
    );
    if (ok == true) {
      await _do(() => api.act(widget.refId, 'STOP_CONTACT'), s.stopped);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final f = _f;
    final t = Theme.of(context).textTheme;
    return Scaffold(
      appBar: AppBar(
        title: Text(f == null ? '' : s.kind(f.followUp)),
        actions: const [LanguagePicker()],
      ),
      body: f == null
          ? Center(
              child: _error == null
                  ? const CircularProgressIndicator()
                  : Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(_errorText(context, _error!)),
                        OutlinedButton(onPressed: _load, child: Text(s.retry)),
                      ],
                    ),
            )
          : RefreshIndicator(
              onRefresh: _load,
              child: ListView(
                physics: const AlwaysScrollableScrollPhysics(),
                padding: const EdgeInsets.all(16),
                children: [
                  if (f.simulation) _SyntheticBanner(text: s.synthetic),
                  Text(f.labName, style: t.titleMedium),
                  if (f.siteName != null) Text(f.siteName!),
                  const SizedBox(height: 8),
                  Row(
                    children: [
                      _StatusChip(status: f.status),
                      const SizedBox(width: 8),
                      Text(s.dueBy(s.day(f.dueAt))),
                    ],
                  ),
                  if (f.appointmentAt != null) ...[
                    const SizedBox(height: 16),
                    Card(
                      child: ListTile(
                        leading: const Icon(Icons.event),
                        title: Text(s.appointment),
                        subtitle: Text(
                          [
                            s.dayTime(f.appointmentAt!),
                            if (f.appointmentPlace != null) f.appointmentPlace!,
                          ].join('\n'),
                        ),
                      ),
                    ),
                  ],
                  if (f.labWillCall)
                    Padding(
                      padding: const EdgeInsets.only(top: 12),
                      child: Text(s.labWillCall),
                    ),
                  if (f.canBook) ...[
                    const SizedBox(height: 24),
                    Text(s.chooseTime, style: t.titleMedium),
                    const SizedBox(height: 8),
                    if (f.slots.isEmpty) Text(s.noTimes),
                    for (final slot in f.slots)
                      Card(
                        child: ListTile(
                          leading: const Icon(Icons.schedule),
                          title: Text(s.dayTime(slot.startsAt)),
                          subtitle: Text(slot.location),
                          trailing: const Icon(Icons.chevron_right),
                          enabled: !_busy,
                          onTap: () => _book(slot),
                        ),
                      ),
                  ],
                  if (f.status != 'DONE' && f.status != 'CLOSED') ...[
                    const SizedBox(height: 24),
                    OutlinedButton.icon(
                      onPressed: _busy
                          ? null
                          : () => _do(
                              () => api.act(widget.refId, 'REQUEST_CHANGE'),
                              s.requested,
                            ),
                      icon: const Icon(Icons.edit_calendar),
                      label: Text(s.askChange),
                    ),
                    const SizedBox(height: 8),
                    OutlinedButton.icon(
                      onPressed: _busy
                          ? null
                          : () => _do(
                              () => api.act(widget.refId, 'REQUEST_CALLBACK'),
                              s.requested,
                            ),
                      icon: const Icon(Icons.call),
                      label: Text(s.askCall),
                    ),
                    if (f.automatedContact) ...[
                      const SizedBox(height: 8),
                      TextButton.icon(
                        onPressed: _busy ? null : _stop,
                        icon: const Icon(Icons.notifications_off_outlined),
                        label: Text(s.stop),
                      ),
                    ] else
                      Padding(
                        padding: const EdgeInsets.only(top: 8),
                        child: Text(s.stopped),
                      ),
                  ],
                  const SizedBox(height: 24),
                  Text(s.notMedical, style: t.bodySmall),
                ],
              ),
            ),
    );
  }
}
