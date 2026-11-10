// macOS: the app's sound through a Core Audio process tap (macOS 14.2+): main and its children — Chromium plays
// from its audio-service helper, and every media engine is a child of main too — mixed down to stereo, read by a
// private aggregate device's IOProc. The tap is private and unmuted: the room keeps hearing everything.
//
// The first start asks for «System Audio Recording» (Info.plist's NSAudioCaptureUsageDescription, the app's own);
// there is no API to ask beforehand, and a refusal gives silence, not an error — the engine reports the level.
// An engine started later (a new video) joins the tap: the list of processes is followed as it changes.
#include "ndi-audio.h"

#import <CoreAudio/AudioHardwareTapping.h>
#import <CoreAudio/CATapDescription.h>
#import <CoreAudio/CoreAudio.h>
#import <Foundation/Foundation.h>
#include <libproc.h>
#include <mach/mach_time.h>
#include <time.h>

#include <vector>

int64_t nowTc() {
  timespec t;
  clock_gettime(CLOCK_REALTIME, &t);
  return (int64_t)t.tv_sec * 10000000 + t.tv_nsec / 100;
}

namespace {
pid_t app = 0;
AudioSink* sink = nullptr;
AudioObjectID tap = kAudioObjectUnknown, device = kAudioObjectUnknown;
AudioDeviceIOProcID proc = nullptr;
id tapDescription = nil;
AudioObjectPropertyListenerBlock listener = nil;
const AudioObjectPropertyAddress processList{kAudioHardwarePropertyProcessObjectList, kAudioObjectPropertyScopeGlobal,
                                             kAudioObjectPropertyElementMain};

// Main and its children, as Core Audio knows them (a process that never played a sound has no object yet).
NSArray<NSNumber*>* appProcesses() {
  std::vector<pid_t> pids(1024);
  int n = proc_listchildpids(app, pids.data(), (int)(pids.size() * sizeof(pid_t)));
  pids.resize(n > 0 ? n : 0);
  pids.push_back(app);
  NSMutableArray* out = [NSMutableArray array];
  AudioObjectPropertyAddress translate{kAudioHardwarePropertyTranslatePIDToProcessObject, kAudioObjectPropertyScopeGlobal,
                                       kAudioObjectPropertyElementMain};
  for (pid_t pid : pids) {
    AudioObjectID object = kAudioObjectUnknown;
    UInt32 size = sizeof object;
    if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &translate, sizeof pid, &pid, &size, &object) == noErr &&
        object != kAudioObjectUnknown)
      [out addObject:@(object)];
  }
  return out;
}

NSString* defaultOutputUID() {
  AudioObjectPropertyAddress a{kAudioHardwarePropertyDefaultSystemOutputDevice, kAudioObjectPropertyScopeGlobal,
                               kAudioObjectPropertyElementMain};
  AudioObjectID out = kAudioObjectUnknown;
  UInt32 size = sizeof out;
  if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &a, 0, nullptr, &size, &out) != noErr) return nil;
  CFStringRef uid = nullptr;
  AudioObjectPropertyAddress u{kAudioDevicePropertyDeviceUID, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
  size = sizeof uid;
  if (AudioObjectGetPropertyData(out, &u, 0, nullptr, &size, &uid) != noErr || !uid) return nil;
  return (__bridge_transfer NSString*)uid;
}

API_AVAILABLE(macos(14.2)) bool startTap(std::string& why) {
  CATapDescription* description = [[CATapDescription alloc] initStereoMixdownOfProcesses:appProcesses()];
  description.privateTap = YES;
  description.muteBehavior = CATapUnmuted;
  tapDescription = description;
  OSStatus st = AudioHardwareCreateProcessTap(description, &tap);
  if (st != noErr) {
    why = "AudioHardwareCreateProcessTap " + std::to_string((int)st);
    return false;
  }
  NSString* output = defaultOutputUID();
  NSMutableDictionary* aggregate = [@{
    @kAudioAggregateDeviceUIDKey : NSUUID.UUID.UUIDString,
    @kAudioAggregateDeviceNameKey : @"Lumina Live NDI",
    @kAudioAggregateDeviceIsPrivateKey : @YES,
    @kAudioAggregateDeviceIsStackedKey : @NO,
    @kAudioAggregateDeviceTapAutoStartKey : @YES,
    @kAudioAggregateDeviceTapListKey : @[ @{@kAudioSubTapUIDKey : description.UUID.UUIDString, @kAudioSubTapDriftCompensationKey : @YES} ],
  } mutableCopy];
  if (output) {
    aggregate[@kAudioAggregateDeviceMainSubDeviceKey] = output;
    aggregate[@kAudioAggregateDeviceSubDeviceListKey] = @[ @{@kAudioSubDeviceUIDKey : output} ];
  }
  st = AudioHardwareCreateAggregateDevice((__bridge CFDictionaryRef)aggregate, &device);
  if (st != noErr) {
    why = "AudioHardwareCreateAggregateDevice " + std::to_string((int)st);
    return false;
  }
  AudioStreamBasicDescription format{};
  UInt32 size = sizeof format;
  AudioObjectPropertyAddress f{kAudioTapPropertyFormat, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
  if (AudioObjectGetPropertyData(tap, &f, 0, nullptr, &size, &format) != noErr || format.mFormatID != kAudioFormatLinearPCM ||
      !(format.mFormatFlags & kAudioFormatFlagIsFloat) || format.mBitsPerChannel != 32) {
    why = "the tap's format is not 32-bit float";
    return false;
  }
  const bool planar = format.mFormatFlags & kAudioFormatFlagIsNonInterleaved;
  const int channels = (int)format.mChannelsPerFrame;
  const int rate = (int)format.mSampleRate;
  static mach_timebase_info_data_t timebase;
  mach_timebase_info(&timebase);
  __block std::vector<float> interleaved;
  st = AudioDeviceCreateIOProcIDWithBlock(
      &proc, device, nullptr,
      ^(const AudioTimeStamp*, const AudioBufferList* in, const AudioTimeStamp* when, AudioBufferList*, const AudioTimeStamp*) {
        if (!in || in->mNumberBuffers == 0) return;
        // ponytail: allocation on Core Audio's IO thread the first time a buffer is larger than before; a fixed
        // ring if it is ever heard to glitch.
        int frames;
        const float* data;
        if (planar && in->mNumberBuffers >= 2) {
          frames = (int)(in->mBuffers[0].mDataByteSize / sizeof(float));
          interleaved.resize((size_t)frames * 2);
          const float* l = (const float*)in->mBuffers[0].mData;
          const float* r = (const float*)in->mBuffers[1].mData;
          for (int i = 0; i < frames; i++) {
            interleaved[2 * i] = l[i];
            interleaved[2 * i + 1] = r[i];
          }
          data = interleaved.data();
        } else {
          frames = (int)(in->mBuffers[0].mDataByteSize / (sizeof(float) * (planar ? 1 : channels)));
          data = (const float*)in->mBuffers[0].mData;
        }
        if (!data || frames <= 0) return;
        // How long ago its first sample was taken, in 100 ns: the timecode is when the room heard it.
        uint64_t host = (when && (when->mFlags & kAudioTimeStampHostTimeValid)) ? when->mHostTime : mach_absolute_time();
        uint64_t nowHost = mach_absolute_time();
        int64_t age = nowHost > host ? (int64_t)((nowHost - host) * timebase.numer / timebase.denom / 100) : 0;
        sink->push(data, frames, planar ? 2 : channels, rate, nowTc() - age);
      });
  if (st != noErr) {
    why = "AudioDeviceCreateIOProcIDWithBlock " + std::to_string((int)st);
    return false;
  }
  // A media engine started now plays from a process the tap does not include yet: follow the list.
  listener = ^(UInt32, const AudioObjectPropertyAddress*) {
    if (tap == kAudioObjectUnknown) return;
    CATapDescription* current = tapDescription;
    current.processes = appProcesses();
    AudioObjectPropertyAddress d{kAudioTapPropertyDescription, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
    AudioObjectSetPropertyData(tap, &d, 0, nullptr, sizeof current, &current);
  };
  AudioObjectAddPropertyListenerBlock(kAudioObjectSystemObject, &processList,
                                      dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), listener);
  st = AudioDeviceStart(device, proc);  // the first start is when macOS asks for the permission
  if (st != noErr) {
    why = "AudioDeviceStart " + std::to_string((int)st);
    return false;
  }
  return true;
}
}  // namespace

bool startAppAudio(unsigned long appPid, AudioSink* audioSink, std::string& why) {
  app = (pid_t)appPid;
  sink = audioSink;
  if (@available(macOS 14.2, *)) {
    if (startTap(why)) return true;
    stopAppAudio();
    return false;
  }
  why = "macOS 14.2 or later";
  return false;
}

void stopAppAudio() {
  if (listener) AudioObjectRemovePropertyListenerBlock(kAudioObjectSystemObject, &processList,
                                                       dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), listener);
  listener = nil;
  if (device != kAudioObjectUnknown && proc) {
    AudioDeviceStop(device, proc);
    AudioDeviceDestroyIOProcID(device, proc);
  }
  proc = nullptr;
  if (device != kAudioObjectUnknown) AudioHardwareDestroyAggregateDevice(device);
  device = kAudioObjectUnknown;
  if (@available(macOS 14.2, *)) {
    if (tap != kAudioObjectUnknown) AudioHardwareDestroyProcessTap(tap);
  }
  tap = kAudioObjectUnknown;
  tapDescription = nil;
}
