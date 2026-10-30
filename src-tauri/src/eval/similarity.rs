//! Text similarity used to score prompt-suite answers.

fn words(s: &str) -> Vec<String> {
    s.split(|c: char| c.is_whitespace())
        .map(|w| {
            w.trim_matches(|c: char| !c.is_alphanumeric())
                .to_lowercase()
        })
        .filter(|w| !w.is_empty())
        .collect()
}

/// Lowercase, collapse whitespace, trim surrounding punctuation (accents are kept).
pub fn normalize(s: &str) -> String {
    s.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .trim_matches(|c: char| ".,;:!?\"'`".contains(c))
        .to_lowercase()
}

/// Answer counts as correct when the normalized reference appears in the normalized output.
pub fn exact_match(output: &str, reference: &str) -> bool {
    let r = normalize(reference);
    !r.is_empty() && normalize(output).contains(&r)
}

/// ROUGE-L F1 over words (longest common subsequence).
pub fn rouge_l(a: &str, b: &str) -> f64 {
    let (x, y) = (words(a), words(b));
    if x.is_empty() || y.is_empty() {
        return if x.is_empty() && y.is_empty() {
            1.0
        } else {
            0.0
        };
    }
    let mut prev = vec![0usize; y.len() + 1];
    for xi in &x {
        let mut cur = vec![0usize; y.len() + 1];
        for (j, yj) in y.iter().enumerate() {
            cur[j + 1] = if xi == yj {
                prev[j] + 1
            } else {
                cur[j].max(prev[j + 1])
            };
        }
        prev = cur;
    }
    let lcs = prev[y.len()] as f64;
    let p = lcs / x.len() as f64;
    let r = lcs / y.len() as f64;
    if p + r == 0.0 {
        0.0
    } else {
        2.0 * p * r / (p + r)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scores() {
        assert!(exact_match("The answer is **Paris**.", "Paris"));
        assert!(exact_match("Hà Nội là thủ đô.", "Hà Nội"));
        assert!(!exact_match("London", "Paris"));
        assert!((rouge_l("the cat sat on the mat", "the cat sat on the mat") - 1.0).abs() < 1e-9);
        let r = rouge_l("the cat sat", "the dog sat");
        assert!(r > 0.6 && r < 0.7, "{r}");
    }
}
