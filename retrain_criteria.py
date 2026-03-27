"""
Retrains the 7-criterion reasoning quality model using all-MiniLM-L6-v2 embeddings
(JS-compatible -- no TF-IDF). Exports weights to criteria_model.json and instability
pipeline parameters to instability_params.json.

Implements: "Temporal Instability Phases Precede and Predict Reasoning Error in GPTs"
by Venkata S. Pendyala

Input CSV: LatestModelData/reasoning_7d_balanced_augmented.csv
  Columns: conversation_index, turn_index, user_prompt, assistant_response,
           relevance_to_prompt, directly_addresses_question,
           step_by_step_or_structured_reasoning, uses_justification_or_explanation,
           internally_consistent, acknowledges_uncertainty_or_limits_when_needed,
           sufficiently_complete_for_prompt, reasoning_score_7d, is_synthetic
  1158 rows, 99 conversations, label 1=pass 0=fail

Outputs:
  criteria_model.json     -- 7 logistic regression classifiers (384-dim MiniLM weights)
  instability_params.json -- PCA + K-means instability pipeline parameters
"""

import json
import warnings

import numpy as np
import pandas as pd
from scipy.stats import spearmanr
from sentence_transformers import SentenceTransformer
from sklearn.cluster import KMeans
from sklearn.decomposition import PCA
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import classification_report, f1_score

warnings.filterwarnings("ignore")

# --- Config -------------------------------------------------------------------

CSV_PATH = "LatestModelData/reasoning_7d_balanced_augmented.csv"
CRITERIA_OUT = "criteria_model.json"
INSTABILITY_OUT = "instability_params.json"

LABEL_COLS = [
    "relevance_to_prompt",
    "directly_addresses_question",
    "step_by_step_or_structured_reasoning",
    "uses_justification_or_explanation",
    "internally_consistent",
    "acknowledges_uncertainty_or_limits_when_needed",
    "sufficiently_complete_for_prompt",
]

LABEL_DISPLAY = [
    "C1 -- Relevant to Prompt",
    "C2 -- Directly Addresses Question",
    "C3 -- Structured Reasoning",
    "C4 -- Uses Justification",
    "C5 -- Internally Consistent",
    "C6 -- Acknowledges Uncertainty",
    "C7 -- Sufficiently Complete",
]

W_S = 3
W_L = 10

# --- Helpers ------------------------------------------------------------------

def safe_int01(x):
    try:
        v = int(float(x))
        return 1 if v == 1 else 0
    except Exception:
        return 0


def build_text(user_prompt, assistant_response):
    return f"[PROMPT]\n{str(user_prompt).strip()}\n\n[RESPONSE]\n{str(assistant_response).strip()}"


def pick_threshold(y_true, y_prob):
    best_t, best_f1 = 0.5, -1.0
    for t in np.linspace(0.05, 0.95, 19):
        yp = (y_prob >= t).astype(int)
        f1 = f1_score(y_true, yp, zero_division=0)
        if f1 > best_f1:
            best_f1, best_t = float(f1), float(t)
    return best_t, best_f1


def lcr(arr):
    """Longest contiguous run of 1s in arr."""
    best, cur = 0, 0
    for v in arr:
        cur = cur + 1 if v else 0
        best = max(best, cur)
    return best

# --- Load & Prep --------------------------------------------------------------

print("Loading dataset...")
df = pd.read_csv(CSV_PATH)

for c in LABEL_COLS:
    df[c] = df[c].apply(safe_int01)

df["reasoning_score_7d"] = pd.to_numeric(df["reasoning_score_7d"], errors="coerce")
df = df.dropna(subset=["user_prompt", "assistant_response"]).reset_index(drop=True)

df["text"] = df.apply(
    lambda r: build_text(r["user_prompt"], r["assistant_response"]),
    axis=1,
)

print(f"Rows after cleaning: {len(df)}")
print(f"Unique conversations: {df['conversation_index'].nunique()}")

# --- Conversation-level train/test split (80/20) ------------------------------

rng = np.random.default_rng(42)
conv_ids = df["conversation_index"].unique()
rng.shuffle(conv_ids)
n_train = int(len(conv_ids) * 0.8)
train_convs = set(conv_ids[:n_train])
test_convs  = set(conv_ids[n_train:])

train_mask = df["conversation_index"].isin(train_convs)
test_mask  = df["conversation_index"].isin(test_convs)

df_train = df[train_mask].reset_index(drop=True)
df_test  = df[test_mask].reset_index(drop=True)

print(f"Train turns: {len(df_train)}  |  Test turns: {len(df_test)}")
print(f"Train convs: {len(train_convs)}  |  Test convs: {len(test_convs)}")

# --- Embed --------------------------------------------------------------------

print("\nGenerating embeddings with all-MiniLM-L6-v2...")
embedder = SentenceTransformer("all-MiniLM-L6-v2")

X_train = embedder.encode(
    df_train["text"].tolist(),
    show_progress_bar=True,
    normalize_embeddings=True,
    batch_size=64,
)

X_test = embedder.encode(
    df_test["text"].tolist(),
    show_progress_bar=True,
    normalize_embeddings=True,
    batch_size=64,
)

print(f"X_train shape: {X_train.shape}  |  X_test shape: {X_test.shape}")

# --- Train 7 Logistic Regression Classifiers ---------------------------------

print("\nTraining 7 logistic regression classifiers...")
classifiers = []
criteria_export = {"model": "Xenova/all-MiniLM-L6-v2", "criteria": []}

for i, col in enumerate(LABEL_COLS):
    y_train = df_train[col].values.astype(int)
    y_test  = df_test[col].values.astype(int)

    clf = LogisticRegression(
        C=2.0,
        max_iter=4000,
        class_weight="balanced",
        solver="liblinear",
    )
    clf.fit(X_train, y_train)

    # Threshold: optimise F1 on training set
    train_prob = clf.predict_proba(X_train)[:, 1]
    threshold, train_f1 = pick_threshold(y_train, train_prob)

    test_prob = clf.predict_proba(X_test)[:, 1]
    test_pred = (test_prob >= threshold).astype(int)

    print(f"\n[{col}]  threshold={threshold:.2f}  train_f1={train_f1:.3f}")
    print(classification_report(y_test, test_pred, target_names=["fail", "pass"], zero_division=0))

    classifiers.append(clf)
    criteria_export["criteria"].append({
        "name":      col,
        "label":     LABEL_DISPLAY[i],
        "threshold": round(threshold, 6),
        "coef":      clf.coef_[0].tolist(),
        "intercept": float(clf.intercept_[0]),
    })

# --- Instability Pipeline (from training turns only) -------------------------

print("\nComputing instability pipeline parameters from training turns...")

# Failure probability per criterion for every training turn
fail_probs_matrix = np.zeros((len(df_train), 7), dtype=float)
for k, clf in enumerate(classifiers):
    pass_prob = clf.predict_proba(X_train)[:, 1]
    fail_probs_matrix[:, k] = 1.0 - pass_prob

# f_t = Σ failure probabilities (continuous, 0-7)
f_all = fail_probs_matrix.sum(axis=1)

# tau = 65th percentile of training f_t
tau = float(np.percentile(f_all, 65))
print(f"tau (65th pct of training f_t): {tau:.4f}")

# Compute instability features per conversation
delta_vals   = []
burst_vals   = []
maxshift_vals = []

for conv_id in train_convs:
    conv_mask = df_train["conversation_index"] == conv_id
    conv_df   = df_train[conv_mask].copy()
    # Sort by turn_index to get temporal order
    conv_df = conv_df.sort_values("turn_index").reset_index(drop=True)
    conv_indices = conv_df.index.tolist()

    # Get f and e arrays for this conversation
    f_conv = f_all[conv_mask][conv_df.index if hasattr(conv_df.index, 'tolist') else slice(None)]
    # Re-index to match sorted conv_df
    orig_positions = df_train[conv_mask].sort_values("turn_index").index
    f_conv = f_all[orig_positions]
    p_conv = fail_probs_matrix[orig_positions]  # shape (T, 7)
    e_conv = (f_conv >= tau).astype(int)

    T = len(f_conv)
    for t in range(W_L, T):  # t >= W_L (0-indexed: position >= W_L means at least W_L turns available)
        short_f = f_conv[t - W_S: t]
        long_f  = f_conv[t - W_L: t]
        short_e = e_conv[t - W_S: t]
        short_p = p_conv[t - W_S: t]   # shape (W_S, 7)
        long_p  = p_conv[t - W_L: t]   # shape (W_L, 7)

        delta    = float(short_f.mean() - long_f.mean())
        burst    = lcr(short_e) / W_S
        maxshift = float(np.max(short_p.mean(axis=0) - long_p.mean(axis=0)))

        delta_vals.append(delta)
        burst_vals.append(burst)
        maxshift_vals.append(maxshift)

delta_vals    = np.array(delta_vals)
burst_vals    = np.array(burst_vals)
maxshift_vals = np.array(maxshift_vals)

print(f"Instability feature vectors: {len(delta_vals)} turns")

# Standardization moments
mu_delta    = float(delta_vals.mean())
sigma_delta = float(delta_vals.std()) or 1.0
mu_burst    = float(burst_vals.mean())
sigma_burst = float(burst_vals.std()) or 1.0
mu_maxshift = float(maxshift_vals.mean())
sigma_maxshift = float(maxshift_vals.std()) or 1.0

delta_z    = (delta_vals    - mu_delta)    / sigma_delta
burst_z    = (burst_vals    - mu_burst)    / sigma_burst
maxshift_z = (maxshift_vals - mu_maxshift) / sigma_maxshift

features = np.column_stack([delta_z, burst_z, maxshift_z])  # shape (N, 3)

# PCA(n_components=1) on standardized features
pca = PCA(n_components=1)
pca.fit(features)

I_t = pca.transform(features).ravel()  # PC1 scores

# Orient sign: PC1 should positively correlate with delta (higher delta -> higher I)
corr, _ = spearmanr(delta_vals, I_t)
if corr < 0:
    print("Flipping PC1 sign to align with delta_vals direction.")
    pca.components_ = -pca.components_
    I_t = -I_t

print(f"Spearman(delta, I_t) after orientation: {spearmanr(delta_vals, I_t)[0]:.4f}")

# K-means on I_t (column vector)
kmeans = KMeans(n_clusters=3, n_init=20, random_state=42)
kmeans.fit(I_t.reshape(-1, 1))

# Sort centroids: c0 < c1 < c2
centroids = sorted(kmeans.cluster_centers_.ravel().tolist())
print(f"K-means centroids (sorted): {[round(c, 4) for c in centroids]}")

# --- Export criteria_model.json -----------------------------------------------

print(f"\nWriting {CRITERIA_OUT} ...")
with open(CRITERIA_OUT, "w", encoding="utf-8") as f:
    json.dump(criteria_export, f, ensure_ascii=False)
print(f"  -> {len(criteria_export['criteria'])} criteria classifiers saved")

# --- Export instability_params.json ------------------------------------------

instability_export = {
    "W_S": W_S,
    "W_L": W_L,
    "tau": round(tau, 6),
    "delta":    {"mu": round(mu_delta,    6), "sigma": round(sigma_delta,    6)},
    "burst":    {"mu": round(mu_burst,    6), "sigma": round(sigma_burst,    6)},
    "maxshift": {"mu": round(mu_maxshift, 6), "sigma": round(sigma_maxshift, 6)},
    "pca_components": pca.components_[0].tolist(),   # [w0, w1, w2]
    "pca_mean":       pca.mean_.tolist(),             # mean of standardised features used to centre PCA
    "kmeans_centroids": [round(c, 6) for c in centroids],  # [c_low, c_mid, c_high]
}

print(f"Writing {INSTABILITY_OUT} ...")
with open(INSTABILITY_OUT, "w", encoding="utf-8") as f:
    json.dump(instability_export, f, indent=2, ensure_ascii=False)
print("  -> instability_params.json saved")

print("\nDone!")
