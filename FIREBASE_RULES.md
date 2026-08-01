# Firebase Realtime Database Rules for Wotchly

## ✅ Production Rules (Updated — matches actual app code)

**Project:** `<your-firebase-project-id>` | **Region:** Asia Southeast 1 (Singapore)

Copy and paste these rules in your Firebase Console:
**Firebase Console > Realtime Database > Rules**

```json
{
  "rules": {
    "rooms": {
      ".read": true,
      ".write": true,
      "$roomId": {
        ".read": true,
        ".write": true,
        
        "videoUrl": {
          ".read": true,
          ".write": true,
          ".validate": "newData.isString() && newData.val().length < 10000"
        },
        
        "hdVideoUrl": {
          ".read": true,
          ".write": true,
          ".validate": "newData.isString() && newData.val().length < 10000"
        },
        
        "videoQuality": {
          ".read": true,
          ".write": true,
          ".validate": "newData.isString() && (newData.val() === 'auto' || newData.val() === '360p' || newData.val() === '480p' || newData.val() === '720p' || newData.val() === '1080p' || newData.val() === '1440p' || newData.val() === '2160p')"
        },
        
        "browserUrl": {
          ".read": true,
          ".write": true,
          ".validate": "newData.isString() && newData.val().length < 10000"
        },
        
        "websiteUrl": {
          ".read": true,
          ".write": true,
          ".validate": "newData.isString() && newData.val().length < 10000"
        },
        
        "mode": {
          ".read": true,
          ".write": true,
          ".validate": "newData.isString() && (newData.val() === 'video' || newData.val() === 'browser' || newData.val() === 'website' || newData.val() === 'audio' || newData.val() === 'voice' || newData.val() === 'hdvideo')"
        },
        
        "source": {
          ".read": true,
          ".write": true
        },
        
        "playState": {
          ".read": true,
          ".write": true,
          ".validate": "newData.isString() && (newData.val() === 'playing' || newData.val() === 'paused' || newData.val() === 'stopped' || newData.val() === 'buffering')"
        },
        
        "currentTime": {
          ".read": true,
          ".write": true,
          ".validate": "newData.isNumber() && newData.val() >= 0"
        },
        
        "duration": {
          ".read": true,
          ".write": true,
          ".validate": "newData.isNumber() && newData.val() >= 0"
        },
        
        "volume": {
          ".read": true,
          ".write": true,
          ".validate": "newData.isNumber() && newData.val() >= 0 && newData.val() <= 1"
        },
        
        "muted": {
          ".read": true,
          ".write": true,
          ".validate": "newData.isBoolean()"
        },
        
        "host": {
          ".read": true,
          ".write": true,
          ".validate": "newData.isString() && newData.val().length > 0 && newData.val().length <= 100"
        },
        
        "hostId": {
          ".read": true,
          ".write": true,
          ".validate": "newData.isString()"
        },
        
        "lastUpdatedBy": {
          ".read": true,
          ".write": true,
          ".validate": "newData.isString()"
        },
        
        "lastUpdatedAt": {
          ".read": true,
          ".write": true,
          ".validate": "newData.isNumber()"
        },
        
        "createdAt": {
          ".read": true,
          ".write": true,
          ".validate": "newData.isNumber()"
        },
        
        "locked": {
          ".read": true,
          ".write": true,
          ".validate": "newData.isBoolean()"
        },
        
        "roomName": {
          ".read": true,
          ".write": true,
          ".validate": "newData.isString() && newData.val().length <= 100"
        },
        
        "roomPassword": {
          ".read": true,
          ".write": true,
          ".validate": "newData.isString()"
        },
        
        "maxUsers": {
          ".read": true,
          ".write": true,
          ".validate": "newData.isNumber() && newData.val() >= 1 && newData.val() <= 100"
        },
        
        "users": {
          ".read": true,
          ".write": true,
          "$userId": {
            ".read": true,
            ".write": true,
            ".validate": "newData.isString() && newData.val().length > 0 && newData.val().length <= 50"
          }
        },
        
        "userProfiles": {
          ".read": true,
          ".write": true,
          "$usrId": {
            ".read": true,
            ".write": true,
            "username": {
              ".read": true,
              ".write": true,
              ".validate": "newData.isString() && newData.val().length > 0 && newData.val().length <= 50"
            },
            "isVip": {
              ".read": true,
              ".write": true,
              ".validate": "newData.isBoolean()"
            },
            "isHost": {
              ".read": true,
              ".write": true,
              ".validate": "newData.isBoolean()"
            },
            "avatar": {
              ".read": true,
              ".write": true,
              ".validate": "newData.isString()"
            },
            "color": {
              ".read": true,
              ".write": true,
              ".validate": "newData.isString()"
            },
            "joinedAt": {
              ".read": true,
              ".write": true,
              ".validate": "newData.isNumber()"
            },
            "lastActive": {
              ".read": true,
              ".write": true,
              ".validate": "newData.isNumber()"
            },
            "$other": {
              ".read": true,
              ".write": true
            }
          }
        },
        
        "chat": {
          ".read": true,
          ".write": true,
          "$messageId": {
            ".read": true,
            ".write": true,
            ".validate": "newData.hasChildren(['user', 'timestamp'])",
            "user": {
              ".read": true,
              ".write": true,
              ".validate": "newData.isString() && newData.val().length > 0 && newData.val().length <= 50"
            },
            "senderId": {
              ".read": true,
              ".write": true,
              ".validate": "newData.isString()"
            },
            "text": {
              ".read": true,
              ".write": true,
              ".validate": "newData.isString() && newData.val().length <= 2000"
            },
            "type": {
              ".read": true,
              ".write": true,
              ".validate": "newData.isString() && (newData.val() === 'audio' || newData.val() === 'text' || newData.val() === 'system' || newData.val() === 'file' || newData.val() === 'voice')"
            },
            "audioUrl": {
              ".read": true,
              ".write": true,
              ".validate": "newData.isString() && newData.val().length < 21000000"
            },
            "audioData": {
              ".read": true,
              ".write": true,
              ".validate": "newData.isString() && newData.val().length < 21000000"
            },
            "audioFileName": {
              ".read": true,
              ".write": true,
              ".validate": "newData.isString() && newData.val().length <= 500"
            },
            "audioFileSize": {
              ".read": true,
              ".write": true,
              ".validate": "newData.isNumber() && newData.val() >= 0 && newData.val() <= 15728640"
            },
            "audioMimeType": {
              ".read": true,
              ".write": true,
              ".validate": "newData.isString() && newData.val().length <= 100"
            },
            "audioDuration": {
              ".read": true,
              ".write": true,
              ".validate": "newData.isNumber() && newData.val() >= 0"
            },
            "timestamp": {
              ".read": true,
              ".write": true,
              ".validate": "newData.isNumber()"
            },
            "edited": {
              ".read": true,
              ".write": true,
              ".validate": "newData.isBoolean()"
            },
            "editedAt": {
              ".read": true,
              ".write": true,
              ".validate": "newData.isNumber()"
            },
            "deleted": {
              ".read": true,
              ".write": true,
              ".validate": "newData.isBoolean()"
            },
            "replyTo": {
              ".read": true,
              ".write": true,
              ".validate": "newData.isString()"
            },
            "$other": {
              ".read": true,
              ".write": true
            }
          }
        },
        
        "settings": {
          ".read": true,
          ".write": true,
          "theme": {
            ".read": true,
            ".write": true,
            ".validate": "newData.isString() && (newData.val() === 'dark' || newData.val() === 'light' || newData.val() === 'auto')"
          },
          "autoplay": {
            ".read": true,
            ".write": true,
            ".validate": "newData.isBoolean()"
          },
          "syncEnabled": {
            ".read": true,
            ".write": true,
            ".validate": "newData.isBoolean()"
          },
          "chatEnabled": {
            ".read": true,
            ".write": true,
            ".validate": "newData.isBoolean()"
          },
          "voiceEnabled": {
            ".read": true,
            ".write": true,
            ".validate": "newData.isBoolean()"
          },
          "notificationsEnabled": {
            ".read": true,
            ".write": true,
            ".validate": "newData.isBoolean()"
          },
          "defaultQuality": {
            ".read": true,
            ".write": true,
            ".validate": "newData.isString()"
          },
          "browserMode": {
            ".read": true,
            ".write": true,
            ".validate": "newData.isString()"
          },
          "allowGuests": {
            ".read": true,
            ".write": true,
            ".validate": "newData.isBoolean()"
          },
          "maxFileSize": {
            ".read": true,
            ".write": true,
            ".validate": "newData.isNumber() && newData.val() >= 0"
          },
          "$settingKey": {
            ".read": true,
            ".write": true
          }
        },
        
        "audio": {
          ".read": true,
          ".write": true,
          "volume": {
            ".read": true,
            ".write": true,
            ".validate": "newData.isNumber() && newData.val() >= 0 && newData.val() <= 1"
          },
          "bass": {
            ".read": true,
            ".write": true,
            ".validate": "newData.isNumber()"
          },
          "treble": {
            ".read": true,
            ".write": true,
            ".validate": "newData.isNumber()"
          },
          "equalizer": {
            ".read": true,
            ".write": true
          },
          "muted": {
            ".read": true,
            ".write": true,
            ".validate": "newData.isBoolean()"
          },
          "spatialAudio": {
            ".read": true,
            ".write": true,
            ".validate": "newData.isBoolean()"
          },
          "$audioKey": {
            ".read": true,
            ".write": true
          }
        },
        
        "video": {
          ".read": true,
          ".write": true,
          "quality": {
            ".read": true,
            ".write": true,
            ".validate": "newData.isString()"
          },
          "subtitles": {
            ".read": true,
            ".write": true,
            ".validate": "newData.isBoolean()"
          },
          "subtitleLanguage": {
            ".read": true,
            ".write": true,
            ".validate": "newData.isString()"
          },
          "playbackRate": {
            ".read": true,
            ".write": true,
            ".validate": "newData.isNumber() && newData.val() >= 0.25 && newData.val() <= 4"
          },
          "loop": {
            ".read": true,
            ".write": true,
            ".validate": "newData.isBoolean()"
          },
          "pip": {
            ".read": true,
            ".write": true,
            ".validate": "newData.isBoolean()"
          },
          "fullscreen": {
            ".read": true,
            ".write": true,
            ".validate": "newData.isBoolean()"
          },
          "aspectRatio": {
            ".read": true,
            ".write": true,
            ".validate": "newData.isString()"
          },
          "$videoKey": {
            ".read": true,
            ".write": true
          }
        },
        
        "hdVideo": {
          ".read": true,
          ".write": true,
          "enabled": {
            ".read": true,
            ".write": true,
            ".validate": "newData.isBoolean()"
          },
          "resolution": {
            ".read": true,
            ".write": true,
            ".validate": "newData.isString()"
          },
          "bitrate": {
            ".read": true,
            ".write": true,
            ".validate": "newData.isNumber()"
          },
          "hdr": {
            ".read": true,
            ".write": true,
            ".validate": "newData.isBoolean()"
          },
          "$hdKey": {
            ".read": true,
            ".write": true
          }
        },
        
        "voice": {
          ".read": true,
          ".write": true,
          "enabled": {
            ".read": true,
            ".write": true,
            ".validate": "newData.isBoolean()"
          },
          "micEnabled": {
            ".read": true,
            ".write": true,
            ".validate": "newData.isBoolean()"
          },
          "speakerEnabled": {
            ".read": true,
            ".write": true,
            ".validate": "newData.isBoolean()"
          },
          "noiseCancellation": {
            ".read": true,
            ".write": true,
            ".validate": "newData.isBoolean()"
          },
          "echoReduction": {
            ".read": true,
            ".write": true,
            ".validate": "newData.isBoolean()"
          },
          "$voiceKey": {
            ".read": true,
            ".write": true
          }
        },
        
        "browser": {
          ".read": true,
          ".write": true,
          "url": {
            ".read": true,
            ".write": true,
            ".validate": "newData.isString() && newData.val().length < 10000"
          },
          "mode": {
            ".read": true,
            ".write": true,
            ".validate": "newData.isString()"
          },
          "scrollPosition": {
            ".read": true,
            ".write": true
          },
          "zoom": {
            ".read": true,
            ".write": true,
            ".validate": "newData.isNumber() && newData.val() >= 0.25 && newData.val() <= 4"
          },
          "syncScroll": {
            ".read": true,
            ".write": true,
            ".validate": "newData.isBoolean()"
          },
          "history": {
            ".read": true,
            ".write": true
          },
          "$browserKey": {
            ".read": true,
            ".write": true
          }
        },
        
        "website": {
          ".read": true,
          ".write": true,
          "url": {
            ".read": true,
            ".write": true,
            ".validate": "newData.isString() && newData.val().length < 10000"
          },
          "title": {
            ".read": true,
            ".write": true,
            ".validate": "newData.isString() && newData.val().length <= 500"
          },
          "favicon": {
            ".read": true,
            ".write": true,
            ".validate": "newData.isString()"
          },
          "sync": {
            ".read": true,
            ".write": true,
            ".validate": "newData.isBoolean()"
          },
          "$websiteKey": {
            ".read": true,
            ".write": true
          }
        },
        
        "hostControls": {
          ".read": true,
          ".write": true,
          "canChat": {
            ".read": true,
            ".write": true,
            ".validate": "newData.isBoolean()"
          },
          "canVoice": {
            ".read": true,
            ".write": true,
            ".validate": "newData.isBoolean()"
          },
          "canControl": {
            ".read": true,
            ".write": true,
            ".validate": "newData.isBoolean()"
          },
          "canInvite": {
            ".read": true,
            ".write": true,
            ".validate": "newData.isBoolean()"
          },
          "kickedUsers": {
            ".read": true,
            ".write": true
          },
          "bannedUsers": {
            ".read": true,
            ".write": true
          },
          "mutedUsers": {
            ".read": true,
            ".write": true
          },
          "$hostKey": {
            ".read": true,
            ".write": true
          }
        },
        
        "audioFiles": {
          ".read": true,
          ".write": true,
          "$fileId": {
            ".read": true,
            ".write": true,
            "name": {
              ".read": true,
              ".write": true,
              ".validate": "newData.isString() && newData.val().length <= 500"
            },
            "data": {
              ".read": true,
              ".write": true,
              ".validate": "newData.isString() && newData.val().length < 21000000"
            },
            "size": {
              ".read": true,
              ".write": true,
              ".validate": "newData.isNumber() && newData.val() >= 0 && newData.val() <= 15728640"
            },
            "mimeType": {
              ".read": true,
              ".write": true,
              ".validate": "newData.isString() && newData.val().length <= 100"
            },
            "duration": {
              ".read": true,
              ".write": true,
              ".validate": "newData.isNumber() && newData.val() >= 0"
            },
            "uploadedBy": {
              ".read": true,
              ".write": true,
              ".validate": "newData.isString()"
            },
            "uploadedAt": {
              ".read": true,
              ".write": true,
              ".validate": "newData.isNumber()"
            },
            "$other": {
              ".read": true,
              ".write": true
            }
          }
        },
        
        "$other": {
          ".read": true,
          ".write": true
        }
      }
    }
  }
}
```

## Simple Development Rules (Quick Testing)

For quick testing only - use this if the above rules give any issues:

```json
{
  "rules": {
    ".read": true,
    ".write": true
  }
}
```

## How to Apply These Rules

1. Go to https://console.firebase.google.com/
2. Select your project from the Firebase Console
3. Click **"Realtime Database"** in the left sidebar
4. Click the **"Rules"** tab at the top
5. Delete all existing rules
6. Paste the complete rules from above
7. Click **"Publish"** button

## What These Rules Allow

### Room Features

| Feature | Host | Users | Description |
|---------|------|-------|-------------|
| **Video Control** | Full | Full | Load videos, play/pause, seek |
| **HD Video** | Full | Full | 720p, 1080p, 1440p, 4K quality options |
| **Audio Settings** | Full | Full | Volume, equalizer, bass, treble |
| **Chat Messages** | Full | Full | Send text messages up to 2000 chars |
| **Voice Notes** | Full | Full | Record and send voice messages |
| **Audio Files** | Full | Full | Upload audio files up to 15MB |
| **User Management** | Full | Full | Join/leave, change name |
| **Room Settings** | Full | Full | Lock room, transfer host |
| **Browser Mode** | Full | Full | Share and sync web browsing |
| **Website Mode** | Full | Full | Share and sync websites |

### Audio File Upload Limits

| Type | Limit | Description |
|------|-------|-------------|
| **Audio File Size** | 15 MB | Maximum file size (15728640 bytes) |
| **Audio Data (Base64)** | ~21 MB | Base64 encoded data (~1.37x file size) |
| **Audio Duration** | Unlimited | No limit on duration |
| **Supported Formats** | All | MP3, WAV, OGG, AAC, M4A, etc. |

### Settings Configuration

| Setting | Type | Description |
|---------|------|-------------|
| **Theme** | String | dark, light, or auto |
| **Autoplay** | Boolean | Auto-play videos |
| **Sync** | Boolean | Enable sync across users |
| **Chat** | Boolean | Enable/disable chat |
| **Voice** | Boolean | Enable/disable voice chat |
| **Notifications** | Boolean | Enable/disable notifications |
| **Quality** | String | Default video quality |
| **Browser Mode** | String | Browser sharing mode |
| **Guest Access** | Boolean | Allow guest users |

### Voice Chat Features

| Feature | Type | Description |
|---------|------|-------------|
| **Mic Enabled** | Boolean | Microphone status |
| **Speaker Enabled** | Boolean | Speaker status |
| **Noise Cancellation** | Boolean | Background noise reduction |
| **Echo Reduction** | Boolean | Echo cancellation |

### Host Controls

| Control | Type | Description |
|---------|------|-------------|
| **Can Chat** | Boolean | Allow users to chat |
| **Can Voice** | Boolean | Allow users to voice chat |
| **Can Control** | Boolean | Allow users to control playback |
| **Can Invite** | Boolean | Allow users to invite others |
| **Kicked Users** | Object | List of kicked users |
| **Banned Users** | Object | List of banned users |
| **Muted Users** | Object | List of muted users |

## Troubleshooting

### "PERMISSION_DENIED" Error
If you see this error:
1. Make sure you published the rules (click "Publish" button)
2. Wait 1-2 minutes for rules to propagate
3. Try refreshing the page
4. Use the simple development rules temporarily

### Audio Files Not Uploading
Audio files use base64 data encoding. Make sure:
1. The `audioUrl` and `audioData` validations allow up to 21000000 characters (supports ~15MB files)
2. The `chat` and `audioFiles` paths have `.write: true`
3. File size is under 15MB (15728640 bytes)

### Voice Messages Not Saving
Voice messages use base64 audio data. Make sure:
1. The `audioUrl` validation allows up to 21000000 characters
2. The `chat` path has `.write: true`
3. Message type is set to 'audio' or 'voice'

### HD Video Not Working
HD Video streaming requires:
1. Valid video URL in `hdVideoUrl` or `videoUrl`
2. Proper `videoQuality` setting (auto, 720p, 1080p, etc.)
3. `hdVideo` settings configured properly

### Browser/Website Mode Issues
If shared browsing isn't working:
1. Check `browserUrl` or `websiteUrl` is valid (under 10000 chars)
2. Verify `mode` is set to 'browser' or 'website'
3. Ensure `browser` or `website` node settings are correct

### Rules Not Working
Use the **Simple Development Rules** temporarily, then gradually add validations.

## Auto-Cleanup

Room data is automatically deleted when the last user leaves the room.

## Data Structure Overview

```
rooms/
├── $roomId/
│   ├── videoUrl          # Current video URL
│   ├── hdVideoUrl        # HD video URL
│   ├── videoQuality      # Video quality setting
│   ├── browserUrl        # Browser mode URL
│   ├── websiteUrl        # Website mode URL
│   ├── mode              # video/browser/website/audio/voice/hdvideo
│   ├── source            # Video source metadata
│   ├── playState         # playing/paused/stopped/buffering
│   ├── currentTime       # Current playback time
│   ├── duration          # Total duration
│   ├── volume            # Volume level (0-1)
│   ├── muted             # Muted status
│   ├── host              # Host username
│   ├── hostId            # Host user ID
│   ├── lastUpdatedBy     # Last user who made changes
│   ├── lastUpdatedAt     # Timestamp of last update
│   ├── createdAt         # Room creation timestamp
│   ├── locked            # Room lock status
│   ├── roomName          # Room display name
│   ├── roomPassword      # Room password (if any)
│   ├── maxUsers          # Maximum users allowed
│   ├── users/            # Active users list
│   │   └── $userId       # Username
│   ├── userProfiles/     # Detailed user profiles
│   │   └── $userId/
│   │       ├── username
│   │       ├── isVip
│   │       ├── isHost
│   │       ├── avatar
│   │       ├── color
│   │       ├── joinedAt
│   │       └── lastActive
│   ├── chat/             # Chat messages
│   │   └── $messageId/
│   │       ├── user
│   │       ├── senderId
│   │       ├── text
│   │       ├── type      # text/audio/voice/system/file
│   │       ├── audioUrl  # For audio messages (up to 15MB)
│   │       ├── audioData # Base64 audio data
│   │       ├── audioFileName
│   │       ├── audioFileSize
│   │       ├── audioMimeType
│   │       ├── audioDuration
│   │       └── timestamp
│   ├── settings/         # Room settings
│   │   ├── theme
│   │   ├── autoplay
│   │   ├── syncEnabled
│   │   ├── chatEnabled
│   │   ├── voiceEnabled
│   │   └── ...
│   ├── audio/            # Audio equalizer settings
│   │   ├── volume
│   │   ├── bass
│   │   ├── treble
│   │   └── ...
│   ├── video/            # Video settings
│   │   ├── quality
│   │   ├── subtitles
│   │   ├── playbackRate
│   │   └── ...
│   ├── hdVideo/          # HD Video settings
│   │   ├── enabled
│   │   ├── resolution
│   │   ├── bitrate
│   │   └── hdr
│   ├── voice/            # Voice chat settings
│   │   ├── enabled
│   │   ├── micEnabled
│   │   ├── speakerEnabled
│   │   ├── noiseCancellation
│   │   └── echoReduction
│   ├── browser/          # Browser mode settings
│   │   ├── url
│   │   ├── mode
│   │   ├── scrollPosition
│   │   ├── zoom
│   │   └── syncScroll
│   ├── website/          # Website mode settings
│   │   ├── url
│   │   ├── title
│   │   ├── favicon
│   │   └── sync
│   ├── hostControls/     # Host moderation controls
│   │   ├── canChat
│   │   ├── canVoice
│   │   ├── canControl
│   │   ├── kickedUsers
│   │   ├── bannedUsers
│   │   └── mutedUsers
│   └── audioFiles/       # Uploaded audio files (up to 15MB each)
│       └── $fileId/
│           ├── name
│           ├── data
│           ├── size
│           ├── mimeType
│           ├── duration
│           ├── uploadedBy
│           └── uploadedAt
```
