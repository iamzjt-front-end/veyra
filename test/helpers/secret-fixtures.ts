/** Synthetic recognisable shapes assembled at runtime; none is a usable credential. */
export const patternSecrets = [
  ...["sk-", "sk-proj-", "sk-ant-api03-"].map((prefix) => prefix + "FixtureOnly".repeat(5)),
  ...["ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_"].map(
    (prefix) => prefix + "F".repeat(40),
  ),
  `AIza${"F".repeat(35)}`,
  `xoxb-${"1234567890-".repeat(3)}fixture`,
  `AKIA${"F".repeat(16)}`,
  `ASIA${"F".repeat(16)}`,
  [
    Buffer.from('{"alg":"fixture"}').toString("base64url"),
    Buffer.from('{"sub":"fixture"}').toString("base64url"),
    "not_a_real_signature",
  ].join("."),
];
