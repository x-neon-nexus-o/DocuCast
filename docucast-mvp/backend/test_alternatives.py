#!/usr/bin/env python3
"""
Quick test for DocuCast free alternatives.
Run: python test_alternatives.py

Checks which providers work and tests local fallback generation.
No PDF needed - uses sample text.
"""
import os
from utils.script_generator import generate_script_with_provider, get_available_providers

sample_text = """
Artificial Intelligence is transforming healthcare. Machine learning models can now
diagnose diseases from medical images with accuracy exceeding human doctors.
This document discusses ethical implications, data privacy, bias in training data,
and the need for regulatory frameworks to ensure fairness and accountability.
It also covers future directions for AI in personalized medicine.
"""

print("="*60)
print("DocuCast - Free Alternatives Check")
print("="*60)
print("\nProvider status:")
providers = get_available_providers()
for name, ready in providers.items():
    icon = "✓" if ready else "✗"
    note = "ready" if ready else "not configured"
    if name == "local":
        note = "always ready (unlimited)"
        icon = "✓"
    if name == "ollama":
        note = "ready" if ready else "not running (run `ollama serve`)"
    print(f"  {icon} {name:12} - {note}")

print(f"\nMode: LLM_PROVIDER={os.getenv('LLM_PROVIDER','auto')} (auto = best available)")
print("\nTesting script generation (auto fallback)...")
print("-"*60)

for mode in ["auto", "local"]:
    os.environ["LLM_PROVIDER"] = mode
    try:
        script, provider = generate_script_with_provider(sample_text)
        print(f"\n[{mode}] provider used: {provider}")
        print(f"  Script ({len(script.split())} words):")
        print("  " + script[:300].replace("\n", " ") + "...")
    except Exception as e:
        print(f"\n[{mode}] failed: {e}")

print("\n"+"="*60)
print("To use a free cloud alternative:")
print("  1. Groq (recommended): https://console.groq.com/keys")
print("     -> set GROQ_API_KEY=gsk_... in .env")
print("  2. OpenRouter: https://openrouter.ai/keys")
print("     -> set OPENROUTER_API_KEY=sk-or-v1-...")
print("  3. Offline unlimited: set LLM_PROVIDER=local")
print("  4. Ollama local: https://ollama.com + ollama pull llama3.2")
print("="*60)
print("\nThen: uvicorn main:app --reload")
print("Check: curl http://localhost:8000/providers")
