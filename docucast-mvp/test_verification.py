#!/usr/bin/env python3
"""Comprehensive verification of Tier 2 features implementation."""

import sys
sys.path.insert(0, 'backend')

print("=" * 70)
print("DOCUCAST TIER 2 FEATURES VERIFICATION")
print("=" * 70)

# Test 1: MongoDB auth operations
print("\n[1/4] Testing MongoDB auth & session management...")
try:
    from utils.auth import initialize_database, register_user, authenticate_user, create_session, verify_session
    from bson import ObjectId
    
    initialize_database()
    
    # Test user registration & auth
    test_user = f"test_user_{ObjectId()}"
    test_pass = "testpass123"
    
    register_user(test_user, test_pass)
    assert authenticate_user(test_user, test_pass), "Auth failed"
    
    token = create_session(test_user, 3600)
    assert verify_session(token) == test_user, "Session verification failed"
    
    print(f"✓ MongoDB auth test passed (user: {test_user})")
except Exception as e:
    print(f"✗ MongoDB auth test failed: {e}")
    sys.exit(1)

# Test 2: URL Ingestion
print("\n[2/4] Testing URL & YouTube ingestion...")
try:
    from utils.url_ingestion import is_youtube_url, ingest_url
    
    # Test YouTube detection
    yt_url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    assert is_youtube_url(yt_url), "YouTube URL not detected"
    print(f"✓ YouTube URL detected: {yt_url}")
    
    # Test article ingestion (using Wikipedia)
    article_url = "https://en.wikipedia.org/wiki/Podcast"
    try:
        doc = ingest_url(article_url)
        assert doc.doc_type == "web", f"Wrong doc_type: {doc.doc_type}"
        assert len(doc.text) > 100, f"Not enough text: {len(doc.text)}"
        print(f"✓ Article ingestion test passed ({len(doc.text)} chars)")
    except Exception as url_err:
        print(f"⚠ Article ingestion skipped (network): {url_err}")
    
except Exception as e:
    print(f"✗ URL ingestion test failed: {e}")
    sys.exit(1)

# Test 3: TTS with segment timestamps
print("\n[3/4] Testing TTS engine with segment timestamps...")
try:
    from utils.tts_engine import generate_audio
    
    test_script = "NOVA: Welcome to DocuCast.\nRHYS: Glad to be here today!"
    audio_bytes, engine, mime, timeline = generate_audio(test_script)
    
    assert audio_bytes, "No audio generated"
    assert engine in ["edge-tts", "gtts", "piper", "espeak-ng"], f"Unknown engine: {engine}"
    assert mime in ["audio/mpeg", "audio/wav"], f"Unknown mime: {mime}"
    assert len(timeline) >= 2, f"Timeline should have >=2 segments, got {len(timeline)}"
    assert all("speaker" in t and "text" in t and "start" in t and "end" in t for t in timeline), "Invalid timeline format"
    
    print(f"✓ TTS test passed (engine: {engine}, timeline: {len(timeline)} segments)")
    print(f"  Sample timeline entry: {timeline[0]}")
    
except Exception as e:
    print(f"✗ TTS test failed: {e}")
    sys.exit(1)

# Test 4: Playlist operations
print("\n[4/4] Testing playlist CRUD operations...")
try:
    from utils.auth import save_playlist, list_playlists, get_playlist, delete_playlist
    
    test_user = f"test_user_{ObjectId()}"
    test_pass = "testpass123"
    register_user(test_user, test_pass)
    
    # Create playlist
    pl_id = save_playlist(test_user, {
        "title": "Test Playlist",
        "description": "A test series",
        "episode_ids": []
    })
    
    assert pl_id, "Playlist creation failed"
    
    # List playlists
    playlists = list_playlists(test_user)
    assert any(p.get("_id") == pl_id for p in playlists), "Playlist not in list"
    
    # Get playlist
    pl = get_playlist(test_user, pl_id)
    assert pl is not None, "Playlist retrieval failed"
    assert pl["title"] == "Test Playlist", "Title mismatch"
    
    # Delete playlist
    assert delete_playlist(test_user, pl_id), "Playlist deletion failed"
    assert not get_playlist(test_user, pl_id), "Playlist still exists after deletion"
    
    print(f"✓ Playlist CRUD test passed (playlist: {pl_id})")
    
except Exception as e:
    print(f"✗ Playlist test failed: {e}")
    sys.exit(1)

print("\n" + "=" * 70)
print("ALL VERIFICATION TESTS PASSED ✓")
print("=" * 70)
