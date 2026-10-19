//! Windows Job Object。
//! セッションの bash.exe をJobに入れておくと、その子孫（claude / MCPサーバー / 実行コマンド）も
//! 同じJobに入る。ハンドルを閉じた時点（セッションを閉じた時・アプリ終了時）にまとめて終了する。

#[cfg(windows)]
mod imp {
    use std::{ffi::c_void, mem, ptr};
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

    pub struct Job(HANDLE);

    // HANDLE は生ポインタだが、カーネルオブジェクトのハンドルはスレッド間で共有して問題ない
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    impl Job {
        pub fn for_process(pid: u32) -> Result<Job, String> {
            unsafe {
                let job = CreateJobObjectW(ptr::null(), ptr::null());
                if job.is_null() {
                    return Err("CreateJobObjectW に失敗しました".into());
                }
                let job = Job(job);

                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let ok = SetInformationJobObject(
                    job.0,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const c_void,
                    mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if ok == 0 {
                    return Err("SetInformationJobObject に失敗しました".into());
                }

                let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
                if process.is_null() {
                    return Err(format!("プロセス {pid} を開けませんでした"));
                }
                let ok = AssignProcessToJobObject(job.0, process);
                CloseHandle(process);
                if ok == 0 {
                    return Err("AssignProcessToJobObject に失敗しました".into());
                }
                Ok(job)
            }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

#[cfg(not(windows))]
mod imp {
    /// Windows以外では何もしない（開発・動作確認用）
    pub struct Job;
    impl Job {
        pub fn for_process(_pid: u32) -> Result<Job, String> {
            Ok(Job)
        }
    }
}

pub use imp::Job;
