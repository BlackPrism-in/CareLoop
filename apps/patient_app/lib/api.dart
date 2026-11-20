import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;

/// CareLoop patient API (`/v1/m/*` on the web-api service).
/// Override the server with `--dart-define=API_BASE_URL=https://...`.
const apiBaseUrl = String.fromEnvironment(
  'API_BASE_URL',
  defaultValue: 'https://careloop-web-api-94524397144.asia-south1.run.app',
);

class ApiException implements Exception {
  ApiException(this.status, this.code, this.message);
  final int status;
  final String code;
  final String message;
  bool get signedOut => status == 401;
  @override
  String toString() => message;
}

class StartResult {
  StartResult({this.simulatedCode, this.simulatedReason});

  /// Only for synthetic demo labs when WhatsApp is not live for this number.
  final String? simulatedCode;
  final String? simulatedReason;
}

class Slot {
  Slot(this.slotId, this.startsAt, this.location);
  final String slotId;
  final DateTime startsAt;
  final String location;
  factory Slot.fromJson(Map<String, dynamic> j) => Slot(
    j['slotId'] as String,
    DateTime.parse(j['startsAt'] as String),
    j['location'] as String,
  );
}

class FollowUp {
  FollowUp({
    required this.ref,
    required this.labName,
    required this.siteName,
    required this.followUp,
    required this.dueAt,
    required this.status,
    required this.appointmentAt,
    required this.appointmentPlace,
    required this.labWillCall,
    required this.automatedContact,
    required this.canBook,
    required this.simulation,
    this.slots = const [],
  });

  final String ref;
  final String labName;
  final String? siteName;

  /// CONSULTATION or ORDERED_TEST
  final String followUp;
  final DateTime dueAt;

  /// NOT_BOOKED, REQUEST_RECEIVED, BOOKED, DONE, CLOSED
  final String status;
  final DateTime? appointmentAt;
  final String? appointmentPlace;
  final bool labWillCall;
  final bool automatedContact;
  final bool canBook;
  final bool simulation;
  final List<Slot> slots;

  factory FollowUp.fromJson(Map<String, dynamic> j) {
    final a = j['appointment'] as Map<String, dynamic>?;
    return FollowUp(
      ref: j['ref'] as String,
      labName: j['labName'] as String,
      siteName: j['siteName'] as String?,
      followUp: j['followUp'] as String,
      dueAt: DateTime.parse(j['dueAt'] as String),
      status: j['status'] as String,
      appointmentAt: a == null ? null : DateTime.parse(a['startsAt'] as String),
      appointmentPlace: a?['location'] as String?,
      labWillCall: j['labWillCall'] as bool? ?? false,
      automatedContact: j['automatedContact'] as bool? ?? false,
      canBook: j['canBook'] as bool? ?? false,
      simulation: j['simulation'] as bool? ?? false,
      slots: ((j['slots'] as List?) ?? [])
          .map((s) => Slot.fromJson(s as Map<String, dynamic>))
          .toList(),
    );
  }
}

class CareLoopApi {
  CareLoopApi({http.Client? client, FlutterSecureStorage? storage})
    : _http = client ?? http.Client(),
      _storage = storage ?? const FlutterSecureStorage();

  final http.Client _http;
  final FlutterSecureStorage _storage;
  static const _tokenKey = 'careloop_session';
  String? _token;

  /// A storage failure must never stop the app from starting: treat it as signed out.
  Future<bool> restoreSession() async {
    try {
      _token = await _storage.read(key: _tokenKey);
    } catch (_) {
      _token = null;
    }
    return _token != null;
  }

  Future<Map<String, dynamic>> _call(
    String method,
    String path, [
    Object? body,
  ]) async {
    final req = http.Request(method, Uri.parse('$apiBaseUrl$path'))
      ..headers['content-type'] = 'application/json';
    if (_token != null) req.headers['authorization'] = 'Bearer $_token';
    if (body != null) req.body = jsonEncode(body);
    final http.StreamedResponse sent;
    try {
      sent = await _http.send(req).timeout(const Duration(seconds: 20));
    } catch (_) {
      throw ApiException(0, 'NETWORK', 'NETWORK');
    }
    final res = await http.Response.fromStream(sent);
    final j = res.body.isEmpty
        ? <String, dynamic>{}
        : jsonDecode(res.body) as Map<String, dynamic>;
    if (res.statusCode >= 400) {
      if (res.statusCode == 401 && _token != null) await signOutLocal();
      throw ApiException(
        res.statusCode,
        j['code'] as String? ?? 'ERROR',
        j['message'] as String? ?? 'Error',
      );
    }
    return j;
  }

  Future<StartResult> startLogin(String phone) async {
    final j = await _call('POST', '/v1/m/auth/start', {'phone': phone});
    return StartResult(
      simulatedCode: j['simulatedCode'] as String?,
      simulatedReason: j['simulatedReason'] as String?,
    );
  }

  Future<void> verifyLogin(String phone, String code) async {
    final j = await _call('POST', '/v1/m/auth/verify', {
      'phone': phone,
      'code': code,
    });
    _token = j['token'] as String;
    try {
      await _storage.write(key: _tokenKey, value: _token);
    } catch (_) {
      // Signed in for this run only; the next launch asks for a code again.
    }
  }

  Future<void> signOutLocal() async {
    _token = null;
    try {
      await _storage.delete(key: _tokenKey);
    } catch (_) {}
  }

  Future<void> signOut() async {
    try {
      await _call('DELETE', '/v1/m/auth/session');
    } catch (_) {
      // Signing out locally is what matters.
    }
    await signOutLocal();
  }

  Future<({String language, List<FollowUp> followUps})> followUps() async {
    final j = await _call('GET', '/v1/m/me');
    return (
      language: j['language'] as String? ?? 'en-IN',
      followUps: (j['followUps'] as List)
          .map((f) => FollowUp.fromJson(f as Map<String, dynamic>))
          .toList(),
    );
  }

  Future<FollowUp> followUp(String ref) async => FollowUp.fromJson(
    await _call('GET', '/v1/m/cases/${Uri.encodeComponent(ref)}'),
  );

  Future<FollowUp> book(String ref, String slotId) async => FollowUp.fromJson(
    await _call('POST', '/v1/m/cases/${Uri.encodeComponent(ref)}/book', {
      'slotId': slotId,
    }),
  );

  /// REQUEST_CHANGE, REQUEST_CALLBACK or STOP_CONTACT
  Future<FollowUp> act(String ref, String action) async => FollowUp.fromJson(
    await _call('POST', '/v1/m/cases/${Uri.encodeComponent(ref)}/actions', {
      'action': action,
    }),
  );
}
