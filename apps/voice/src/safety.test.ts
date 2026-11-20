import { describe, expect, it } from 'vitest';
import { claimsBooked, looksLikeMedicalQuestion } from './safety';

describe('medical question backstop', () => {
  it.each([
    'Is my report serious?',
    'What does my sugar level being high mean?',
    'Should I stop taking the tablet?',
    'मेरी रिपोर्ट में क्या आया है, गंभीर है क्या?',
    'dawai band kar doon kya',
    'আমার রিপোর্ট কি গুরুতর?',
    'ওষুধ বন্ধ করব?',
  ])('catches %s', (t) => expect(looksLikeMedicalQuestion(t)).toBe(true));

  it.each([
    'Can I come after 5 pm?',
    'Saturday morning works',
    'शाम को आ सकता हूँ',
    'Please call my son instead',
    'বিকেলে আসতে পারি',
  ])('ignores scheduling talk: %s', (t) => expect(looksLikeMedicalQuestion(t)).toBe(false));
});

describe('booking claim detector', () => {
  it.each([
    'Your appointment is booked for Monday.',
    "You're confirmed for 4:30.",
    'It has been scheduled.',
    'आपकी अपॉइंटमेंट बुक हो गया',
    'আপনার অ্যাপয়েন্টমেন্ট বুক হয়ে গেছে',
  ])('flags %s', (t) => expect(claimsBooked(t)).toBe(true));
  it.each(['Your request is with the lab.', 'I will ask the lab to confirm.'])('allows %s', (t) =>
    expect(claimsBooked(t)).toBe(false),
  );
});
