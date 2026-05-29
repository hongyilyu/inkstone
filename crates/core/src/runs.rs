//! In-memory Run registry. Slice-4 placeholder: real fields land
//! in slice 7 when Core spawns the Worker and owns its child handle.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use uuid::Uuid;

#[allow(dead_code)] // gains real fields in slice 7
pub struct RunHandle;

#[derive(Clone, Default)]
pub struct Runs(pub Arc<Mutex<HashMap<Uuid, RunHandle>>>);
