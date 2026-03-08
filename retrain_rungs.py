"""
Retrains the 5-rung scoring model using all-MiniLM-L6-v2 embeddings only
(JS-compatible — no TF-IDF). Exports weights to rung_model.json.

Input columns: prompt, base, r1, r2, r3, r4, r5
Target columns: r1_score, r2_score, r3_score, r4_score, r5_score
"""

import pandas as pd
import numpy as np
import json
import warnings
warnings.filterwarnings("ignore")

from sentence_transformers import SentenceTransformer
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import train_test_split
from sklearn.metrics import f1_score, classification_report

TEXT_COLS   = ["prompt", "base", "r1", "r2", "r3", "r4", "r5"]
TARGET_COLS = ["r1_score", "r2_score", "r3_score", "r4_score", "r5_score"]

def clean(x):
    if pd.isna(x): return ""
    return str(x).replace("\x00", "").strip()

def pick_threshold(y_true, y_prob):
    best_t, best_f1 = 0.5, -1.0
    for t in np.linspace(0.05, 0.95, 19):
        yp = (y_prob >= t).astype(int)
        f1 = f1_score(y_true, yp, zero_division=0)
        if f1 > best_f1:
            best_f1, best_t = float(f1), float(t)
    return best_t, best_f1

print("Loading dataset...")
df = pd.read_csv(r"C:\Users\raghu\YourAIGuard\rungdata.csv")
for c in TEXT_COLS:
    df[c] = df[c].apply(clean)

# Drop rows with missing targets
df = df.dropna(subset=TARGET_COLS)
print(f"Samples after cleaning: {len(df)}")

print("\nGenerating embeddings with all-MiniLM-L6-v2...")
embedder = SentenceTransformer("all-MiniLM-L6-v2")

# Embed each field separately then concatenate (7 fields × 384 dims = 2688 dims)
field_embeddings = []
for c in TEXT_COLS:
    print(f"  Embedding field: {c}")
    emb = embedder.encode(
        df[c].tolist(),
        show_progress_bar=False,
        normalize_embeddings=True,
        batch_size=64
    )
    field_embeddings.append(emb)

X = np.concatenate(field_embeddings, axis=1)
print(f"Feature matrix shape: {X.shape}")

# Split
idx = np.arange(len(df))
train_idx, test_idx = train_test_split(idx, test_size=0.2, random_state=42, shuffle=True)
train_idx, val_idx  = train_test_split(train_idx, test_size=0.2, random_state=42, shuffle=True)

X_train, X_val, X_test = X[train_idx], X[val_idx], X[test_idx]

print("\nTraining 5 logistic regression classifiers...")
classifiers = []
export = {"model": "Xenova/all-MiniLM-L6-v2", "text_cols": TEXT_COLS, "rungs": []}

for col in TARGET_COLS:
    y = (df[col].values > 0.5).astype(int)
    y_train, y_val, y_test = y[train_idx], y[val_idx], y[test_idx]

    clf = LogisticRegression(
        class_weight="balanced",
        max_iter=4000,
        solver="liblinear",
        penalty="l2"
    )
    clf.fit(X_train, y_train)

    val_prob  = clf.predict_proba(X_val)[:, 1]
    threshold, val_f1 = pick_threshold(y_val, val_prob)

    test_prob = clf.predict_proba(X_test)[:, 1]
    test_pred = (test_prob >= threshold).astype(int)

    print(f"\n[{col}] threshold={threshold:.2f} val_f1={val_f1:.3f}")
    print(classification_report(y_test, test_pred, target_names=["fail", "pass"], zero_division=0))

    export["rungs"].append({
        "name": col,
        "threshold": threshold,
        "coef": clf.coef_[0].tolist(),
        "intercept": float(clf.intercept_[0]),
    })

output_path = r"C:\Users\raghu\YourAIGuard\rung_model.json"
with open(output_path, "w") as f:
    json.dump(export, f)

print(f"\nSaved rung_model.json ({len(export['rungs'])} classifiers)")
print("Done!")
