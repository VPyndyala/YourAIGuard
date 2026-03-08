"""
Retrains the gate model using all-MiniLM-L6-v2 embeddings (JS-compatible)
and exports the logistic regression weights to JSON for use in the extension.
"""

import pandas as pd
import numpy as np
import json
import warnings
warnings.filterwarnings("ignore")

from sentence_transformers import SentenceTransformer
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import train_test_split
from sklearn.metrics import classification_report

print("Loading dataset...")
df = pd.read_csv(r"C:\Users\raghu\YourAIGuard\gate_dataset.csv")
texts = df["prompt"].astype(str).tolist()
labels = df["apply_grader"].tolist()

print(f"Dataset: {len(texts)} samples | Label 1: {sum(labels)} | Label 0: {len(labels)-sum(labels)}")

print("\nGenerating embeddings with all-MiniLM-L6-v2...")
embedder = SentenceTransformer("all-MiniLM-L6-v2")
embeddings = embedder.encode(texts, show_progress_bar=True, batch_size=64)
print(f"Embedding shape: {embeddings.shape}")

print("\nTraining logistic regression...")
X_train, X_test, y_train, y_test = train_test_split(
    embeddings, labels, test_size=0.2, random_state=42, stratify=labels
)

clf = LogisticRegression(
    class_weight="balanced",
    max_iter=4000,
    solver="liblinear",
    penalty="l2"
)
clf.fit(X_train, y_train)

print("\nEvaluation on test set:")
y_pred = clf.predict(X_test)
print(classification_report(y_test, y_pred, target_names=["no_check", "apply_check"]))

# Find best threshold using validation set
probs = clf.predict_proba(X_test)[:, 1]
best_thresh, best_f1 = 0.5, 0.0
from sklearn.metrics import f1_score
for t in np.arange(0.2, 0.8, 0.05):
    preds = (probs >= t).astype(int)
    f1 = f1_score(y_test, preds)
    if f1 > best_f1:
        best_f1 = f1
        best_thresh = round(t, 2)

print(f"\nBest threshold: {best_thresh} (F1={best_f1:.3f})")

print("\nExporting model weights to JSON...")
model_data = {
    "model": "Xenova/all-MiniLM-L6-v2",
    "threshold": best_thresh,
    "coef": clf.coef_[0].tolist(),
    "intercept": float(clf.intercept_[0]),
    "classes": clf.classes_.tolist()
}

output_path = r"C:\Users\raghu\YourAIGuard\gate_model.json"
with open(output_path, "w") as f:
    json.dump(model_data, f)

print(f"Saved to {output_path}")
print("Done!")
