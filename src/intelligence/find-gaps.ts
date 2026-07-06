/**
 * Library gap cross-reference (Section 8.6). Candidate generation is the
 * calling model's job (inference, using its music knowledge); this module's
 * job is the measured part: checking each candidate against what the user
 * actually has.
 */

export interface GapCandidate {
  name: string;
  type: "artist" | "album" | "track";
  uri?: string | undefined;
}

export interface GapResult {
  missing: GapCandidate[];
  already_have: { candidate: GapCandidate; reason: string }[];
}

const normalize = (value: string): string => value.trim().toLowerCase();

export function crossReferenceCandidates(
  candidates: GapCandidate[],
  ownedArtistNames: Set<string>,
  libraryContainsByUri: Map<string, boolean>,
): GapResult {
  const owned = new Set([...ownedArtistNames].map(normalize));
  const missing: GapCandidate[] = [];
  const alreadyHave: GapResult["already_have"] = [];

  for (const candidate of candidates) {
    if (candidate.uri && libraryContainsByUri.get(candidate.uri) === true) {
      alreadyHave.push({ candidate, reason: "URI is already saved in the library" });
      continue;
    }
    if (candidate.type === "artist" && owned.has(normalize(candidate.name))) {
      alreadyHave.push({
        candidate,
        reason: "Artist already appears among the user's saved tracks",
      });
      continue;
    }
    missing.push(candidate);
  }
  return { missing, already_have: alreadyHave };
}
