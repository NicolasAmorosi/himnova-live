// macOS: the app's sound through a Core Audio process tap (macOS 14.2+): main and its children — Chromium plays
// from its audio-service helper, and every media engine is a child of main too — mixed down to stereo, read by a
// private aggregate device's IOProc. The tap is private and unmuted: the room keeps hearing everything.
//
// The first start asks for «System Audio Recording» (Info.plist's NSAudioCaptureUsageDescription, the app's own);
// there is no API to ask beforehand, and a refusal gives silence, not an error — the engine reports the level.
// An engine started later (a new video) joins the tap: the list of processes is followed as it changes.
//
// Which output (proto 8): a stereo mixdown taps the processes' sound whatever device it goes to, PREVIEW's
// headphones included; when main names the LIVE output, or says PREVIEW plays apart, the tap is that device's
// (`initWithProcesses:andDeviceUID:withStream:`, the default output's for «auto», followed when it moves), in that
// device's format.
#include "ndi-audio.h"

#import <CoreAudio/AudioHardwareTapping.h>
#import <CoreAudio/CATapDescription.h>
#import <CoreAudio/CoreAudio.h>
#import <Foundation/Foundation.h>
#include <libproc.h>
#include <mach/mach_time.h>
#include <time.h>

#include <atomic>
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
AudioObjectPropertyListenerBlock listener = nil;
// The process list's listener runs here, one at a time: on a concurrent queue an old call could write the previous
// route's description over the new tap (2026-11-15 review). `stopAppAudio` drains it before the tap goes.
dispatch_queue_t listenerQueue = nullptr;
const AudioObjectPropertyAddress processList{kAudioHardwarePropertyProcessObjectList, kAudioObjectPropertyScopeGlobal,
                                             kAudioObjectPropertyElementMain};
// The device the tap hears (nil: every device, the mixdown), whether it stands for the default output, and when the
// IOProc last ran: it runs on the device's clock, silence included, so a pause of a second means the device is gone.
NSString* tappedUID = nil;
bool followsDefault = false;
std::atomic<uint64_t> lastIO{0};
uint64_t startedAt = 0;
mach_timebase_info_data_t timebase;

uint64_t msSince(uint64_t host) {
  uint64_t now = mach_absolute_time();
  return now > host ? (now - host) * timebase.numer / timebase.denom / 1000000 : 0;
}

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

// The default output, as mpv's «auto» and Chromium's «default» play to it (not the system output, where alerts go).
NSString* defaultOutputUID() {
  AudioObjectPropertyAddress a{kAudioHardwarePropertyDefaultOutputDevice, kAudioObjectPropertyScopeGlobal,
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

bool deviceExists(NSString* uid) {
  AudioObjectPropertyAddress a{kAudioHardwarePropertyTranslateUIDToDevice, kAudioObjectPropertyScopeGlobal,
                               kAudioObjectPropertyElementMain};
  CFStringRef key = (__bridge CFStringRef)uid;
  AudioObjectID out = kAudioObjectUnknown;
  UInt32 size = sizeof out;
  return AudioObjectGetPropertyData(kAudioObjectSystemObject, &a, sizeof key, &key, &size, &out) == noErr && out != kAudioObjectUnknown;
}

API_AVAILABLE(macos(14.2)) bool startTap(NSString* deviceUID, std::string& why) {
  CATapDescription* description =
      deviceUID ? [[CATapDescription alloc] initWithProcesses:appProcesses() andDeviceUID:deviceUID withStream:0]
                : [[CATapDescription alloc] initStereoMixdownOfProcesses:appProcesses()];
  description.privateTap = YES;
  description.muteBehavior = CATapUnmuted;
  OSStatus st = AudioHardwareCreateProcessTap(description, &tap);
  if (st != noErr) {
    why = "AudioHardwareCreateProcessTap " + std::to_string((int)st);
    return false;
  }
  // The tap alone, no output device beside it: with one, a device that has inputs too (a USB interface, a virtual
  // loopback) put ITS input first in the IOProc's buffers, and NDI carried that instead of the app (2026-11-15
  // review; measured on ZoomAudioDevice, which has one input and one output). Chromium's own tap capture does the same.
  NSDictionary* aggregate = @{
    @kAudioAggregateDeviceUIDKey : NSUUID.UUID.UUIDString,
    @kAudioAggregateDeviceNameKey : @"Himnova Live NDI",
    @kAudioAggregateDeviceIsPrivateKey : @YES,
    @kAudioAggregateDeviceIsStackedKey : @NO,
    @kAudioAggregateDeviceTapAutoStartKey : @YES,
    @kAudioAggregateDeviceTapListKey : @[ @{@kAudioSubTapUIDKey : description.UUID.UUIDString, @kAudioSubTapDriftCompensationKey : @YES} ],
  };
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
  __block std::vector<float> interleaved;
  st = AudioDeviceCreateIOProcIDWithBlock(
      &proc, device, nullptr,
      ^(const AudioTimeStamp*, const AudioBufferList* in, const AudioTimeStamp* when, AudioBufferList*, const AudioTimeStamp*) {
        lastIO = mach_absolute_time();
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
        // A planar tap of one buffer is one channel: said as two, the sink read twice the buffer (2026-11-15 audit, A39).
        sink->push(data, frames, planar ? (in->mNumberBuffers >= 2 ? 2 : 1) : channels, rate, nowTc() - age);
      });
  if (st != noErr) {
    why = "AudioDeviceCreateIOProcIDWithBlock " + std::to_string((int)st);
    return false;
  }
  // A media engine started now plays from a process the tap does not include yet: follow the list. This tap and this
  // description only, whatever runs by then.
  const AudioObjectID mine = tap;
  listener = ^(UInt32, const AudioObjectPropertyAddress*) {
    description.processes = appProcesses();
    CATapDescription* current = description;
    AudioObjectPropertyAddress d{kAudioTapPropertyDescription, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
    AudioObjectSetPropertyData(mine, &d, 0, nullptr, sizeof current, &current);
  };
  if (!listenerQueue) listenerQueue = dispatch_queue_create("himnova.ndi.processes", DISPATCH_QUEUE_SERIAL);
  AudioObjectAddPropertyListenerBlock(kAudioObjectSystemObject, &processList, listenerQueue, listener);
  startedAt = lastIO = mach_absolute_time();
  st = AudioDeviceStart(device, proc);  // the first start is when macOS asks for the permission
  if (st != noErr) {
    why = "AudioDeviceStart " + std::to_string((int)st);
    return false;
  }
  return true;
}
}  // namespace

bool startAppAudio(unsigned long appPid, const AudioRoute& route, AudioSink* audioSink, std::string& why) {
  app = (pid_t)appPid;
  sink = audioSink;
  if (!timebase.denom) mach_timebase_info(&timebase);
  // mpv names a Core Audio device «coreaudio/<its UID>».
  const std::string prefix = "coreaudio/";
  const bool named = route.device.compare(0, prefix.size(), prefix) == 0;
  followsDefault = !named && route.previewApart;
  tappedUID = named ? @(route.device.substr(prefix.size()).c_str()) : followsDefault ? defaultOutputUID() : nil;
  if (@available(macOS 14.2, *)) {
    if ((!named || deviceExists(tappedUID)) && startTap(tappedUID, why)) return true;
    if (why.empty()) why = "no output " + route.device;
    stopAppAudio();
    return false;
  }
  why = "macOS 14.2 or later";
  return false;
}

bool appAudioHealthy() {
  // The IOProc stopped (its device went), the device the tap hears is gone, or «auto» now means another one.
  if (msSince(lastIO) > 1000 && msSince(startedAt) > 2000) return false;
  if (tappedUID && !deviceExists(tappedUID)) return false;
  if (followsDefault) {
    NSString* now = defaultOutputUID();
    if (now && ![now isEqualToString:tappedUID]) return false;
  }
  return true;
}

void stopAppAudio() {
  if (listener) {
    AudioObjectRemovePropertyListenerBlock(kAudioObjectSystemObject, &processList, listenerQueue, listener);
    dispatch_sync(listenerQueue, ^{});  // a call already running ends before its tap goes
  }
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
}
