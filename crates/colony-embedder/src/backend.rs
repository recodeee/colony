use std::env;
use std::sync::{Arc, Once};

use anyhow::{anyhow, Result};
use tracing::info;

pub const EMBEDDING_DIM: usize = 384;

static LOG_PICK_ONCE: Once = Once::new();

pub trait EmbedderBackend: Send + Sync {
    fn name(&self) -> BackendName;
    fn embed(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>>;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BackendName {
    OrtCuda,
    OrtCpu,
    Tract,
    CpuStub,
}

impl BackendName {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::OrtCuda => "ort-cuda",
            Self::OrtCpu => "ort-cpu",
            Self::Tract => "tract",
            Self::CpuStub => "cpu-stub",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "ort-cuda" => Some(Self::OrtCuda),
            "ort-cpu" => Some(Self::OrtCpu),
            "tract" => Some(Self::Tract),
            "cpu-stub" => Some(Self::CpuStub),
            _ => None,
        }
    }
}

pub fn auto_pick() -> Arc<dyn EmbedderBackend> {
    let backend = debug_forced_backend()
        .and_then(try_backend)
        .or_else(|| try_backend(BackendName::OrtCuda))
        .or_else(|| try_backend(BackendName::OrtCpu))
        .or_else(|| try_backend(BackendName::Tract))
        .or_else(|| try_backend(BackendName::CpuStub))
        .expect("cpu-stub backend must be available; enable the `cpu-stub` feature");

    let name = backend.name().as_str();
    LOG_PICK_ONCE.call_once(|| {
        info!(backend = name, "colony embedder backend selected");
    });
    backend
}

#[cfg(debug_assertions)]
fn debug_forced_backend() -> Option<BackendName> {
    env::var("COLONY_EMBEDDER_FORCE")
        .ok()
        .and_then(|value| BackendName::parse(value.trim()))
}

#[cfg(not(debug_assertions))]
fn debug_forced_backend() -> Option<BackendName> {
    None
}

fn try_backend(name: BackendName) -> Option<Arc<dyn EmbedderBackend>> {
    match name {
        BackendName::OrtCuda => try_ort_cuda().ok(),
        BackendName::OrtCpu => try_ort_cpu().ok(),
        BackendName::Tract => try_tract().ok(),
        BackendName::CpuStub => try_cpu_stub().ok(),
    }
}

#[cfg(feature = "ort-cuda")]
fn try_ort_cuda() -> Result<Arc<dyn EmbedderBackend>> {
    Err(anyhow!(
        "ort-cuda backend is feature-gated but no runtime implementation is wired yet"
    ))
}

#[cfg(not(feature = "ort-cuda"))]
fn try_ort_cuda() -> Result<Arc<dyn EmbedderBackend>> {
    Err(anyhow!("ort-cuda backend not compiled"))
}

#[cfg(feature = "ort-cpu")]
fn try_ort_cpu() -> Result<Arc<dyn EmbedderBackend>> {
    Err(anyhow!(
        "ort-cpu backend is feature-gated but no runtime implementation is wired yet"
    ))
}

#[cfg(not(feature = "ort-cpu"))]
fn try_ort_cpu() -> Result<Arc<dyn EmbedderBackend>> {
    Err(anyhow!("ort-cpu backend not compiled"))
}

#[cfg(feature = "tract")]
fn try_tract() -> Result<Arc<dyn EmbedderBackend>> {
    Err(anyhow!(
        "tract backend is feature-gated but no runtime implementation is wired yet"
    ))
}

#[cfg(not(feature = "tract"))]
fn try_tract() -> Result<Arc<dyn EmbedderBackend>> {
    Err(anyhow!("tract backend not compiled"))
}

#[cfg(feature = "cpu-stub")]
fn try_cpu_stub() -> Result<Arc<dyn EmbedderBackend>> {
    Ok(Arc::new(CpuStubBackend::new()))
}

#[cfg(not(feature = "cpu-stub"))]
fn try_cpu_stub() -> Result<Arc<dyn EmbedderBackend>> {
    Err(anyhow!("cpu-stub backend not compiled"))
}

#[derive(Default)]
pub struct CpuStubBackend;

impl CpuStubBackend {
    pub fn new() -> Self {
        Self
    }
}

impl EmbedderBackend for CpuStubBackend {
    fn name(&self) -> BackendName {
        BackendName::CpuStub
    }

    fn embed(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>> {
        Ok(texts.iter().map(|text| embed_stub(text)).collect())
    }
}

fn embed_stub(text: &str) -> Vec<f32> {
    let mut out = vec![0.0_f32; EMBEDDING_DIM];
    let bytes = text.as_bytes();
    for (index, slot) in out.iter_mut().enumerate() {
        let hash = fnv1a_64(bytes, index as u64);
        let normalized = (hash as f64) / (u64::MAX as f64);
        *slot = (normalized as f32) * 2.0 - 1.0;
    }
    normalize(&mut out);
    out
}

fn fnv1a_64(bytes: &[u8], salt: u64) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325 ^ salt.wrapping_mul(0x100000001b3);
    for &byte in bytes {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn normalize(values: &mut [f32]) {
    let norm: f32 = values.iter().map(|value| value * value).sum::<f32>().sqrt();
    if norm > 0.0 {
        for value in values.iter_mut() {
            *value /= norm;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auto_pick_falls_back_to_cpu_stub() {
        let backend = auto_pick();
        assert_eq!(backend.name(), BackendName::CpuStub);
    }

    #[test]
    fn cpu_stub_embeds_batches_without_batch_runtime_logic() {
        let backend = CpuStubBackend::new();
        let vectors = backend.embed(&["hello", "world"]).unwrap();
        assert_eq!(vectors.len(), 2);
        assert_eq!(vectors[0].len(), EMBEDDING_DIM);
        assert_eq!(vectors[1].len(), EMBEDDING_DIM);
        assert_ne!(vectors[0], vectors[1]);
    }

    #[test]
    fn cpu_stub_is_deterministic_and_unit_norm() {
        let backend = CpuStubBackend::new();
        let first = backend.embed(&["recodee"]).unwrap().remove(0);
        let second = backend.embed(&["recodee"]).unwrap().remove(0);
        assert_eq!(first, second);

        let norm: f32 = first.iter().map(|value| value * value).sum::<f32>().sqrt();
        assert!((norm - 1.0).abs() < 1e-4);
    }

    #[test]
    fn backend_names_are_stable() {
        assert_eq!(BackendName::OrtCuda.as_str(), "ort-cuda");
        assert_eq!(BackendName::OrtCpu.as_str(), "ort-cpu");
        assert_eq!(BackendName::Tract.as_str(), "tract");
        assert_eq!(BackendName::CpuStub.as_str(), "cpu-stub");
    }
}
