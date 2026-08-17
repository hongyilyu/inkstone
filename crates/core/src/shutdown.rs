//! Process-level degraded shutdown, owned by Core's server task. Worker tasks
//! request shutdown here; `main` stops the listener and each WebSocket observes
//! the same sticky signal before the process exits nonzero.

use std::sync::LazyLock;

use tokio::sync::watch;

pub(crate) type Receiver = watch::Receiver<bool>;

static REQUEST: LazyLock<watch::Sender<bool>> = LazyLock::new(|| watch::channel(false).0);

pub(crate) fn subscribe() -> Receiver {
    REQUEST.subscribe()
}

pub(crate) fn request() {
    let _ = REQUEST.send_replace(true);
}

pub(crate) async fn wait(mut receiver: Receiver) {
    let _ = receiver.wait_for(|requested| *requested).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn request_is_sticky_for_late_observers() {
        let receiver = subscribe();
        request();

        wait(receiver.clone()).await;

        assert!(
            *receiver.borrow(),
            "a WebSocket created after the request must close immediately"
        );
    }
}
