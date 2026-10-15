#define UNICODE
#include <windows.h>
#include <string.h>
// Diagnostic: ONLY the CLI process created by PipeProbe.cs is instrumented.
static LRESULT (WINAPI *real_send)(HWND,UINT,WPARAM,LPARAM);
static LRESULT (WINAPI *real_timeout)(HWND,UINT,WPARAM,LPARAM,UINT,UINT,PDWORD_PTR);
static WCHAR logfile[32768];
static void record(UINT message,LPARAM parameter) {
 if(message!=WM_COPYDATA||!parameter)return;
 COPYDATASTRUCT* row=(COPYDATASTRUCT*)parameter;
 if(!row->cbData || row->cbData>8192)return;
 HANDLE log=CreateFileW(logfile,FILE_APPEND_DATA,FILE_SHARE_READ,NULL,OPEN_ALWAYS,FILE_ATTRIBUTE_NORMAL,NULL);
 if(log!=INVALID_HANDLE_VALUE){DWORD count;WriteFile(log,&row->cbData,4,&count,NULL);WriteFile(log,&row->dwData,sizeof(row->dwData),&count,NULL);WriteFile(log,row->lpData,row->cbData,&count,NULL);CloseHandle(log);}
}
static LRESULT WINAPI send_probe(HWND hwnd,UINT message,WPARAM w,LPARAM p){record(message,p);return real_send(hwnd,message,w,p);}
static LRESULT WINAPI timeout_probe(HWND hwnd,UINT message,WPARAM w,LPARAM p,UINT flags,UINT ms,PDWORD_PTR result){record(message,p);return real_timeout(hwnd,message,w,p,flags,ms,result);}
BOOL WINAPI DllMain(HINSTANCE self,DWORD reason,LPVOID unused) {
 if(reason!=DLL_PROCESS_ATTACH)return TRUE;
 DisableThreadLibraryCalls(self);
 if(!GetEnvironmentVariableW(L"CWB_PROBE_LOG",logfile,32768))return FALSE;
 HMODULE user=GetModuleHandleW(L"user32.dll");
 real_send=(void*)GetProcAddress(user,"SendMessageW");real_timeout=(void*)GetProcAddress(user,"SendMessageTimeoutW");
 BYTE* base=(BYTE*)GetModuleHandleW(NULL);IMAGE_DOS_HEADER* dos=(IMAGE_DOS_HEADER*)base;
 IMAGE_NT_HEADERS* nt=(IMAGE_NT_HEADERS*)(base+dos->e_lfanew);
 IMAGE_IMPORT_DESCRIPTOR* imports=(void*)(base+nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT].VirtualAddress);
 for(;imports->Name;imports++) {
  if(!imports->OriginalFirstThunk)continue;
  IMAGE_THUNK_DATA* names=(void*)(base+imports->OriginalFirstThunk);IMAGE_THUNK_DATA* addresses=(void*)(base+imports->FirstThunk);
  for(;names->u1.AddressOfData;names++,addresses++){
   if(IMAGE_SNAP_BY_ORDINAL(names->u1.Ordinal))continue;
   IMAGE_IMPORT_BY_NAME* name=(void*)(base+names->u1.AddressOfData);ULONG_PTR replacement=0;
   if(!strcmp((char*)name->Name,"SendMessageW"))replacement=(ULONG_PTR)send_probe;
   if(!strcmp((char*)name->Name,"SendMessageTimeoutW"))replacement=(ULONG_PTR)timeout_probe;
   DWORD old;if(replacement && VirtualProtect(&addresses->u1.Function,sizeof(ULONG_PTR),PAGE_READWRITE,&old)){
    addresses->u1.Function=replacement;VirtualProtect(&addresses->u1.Function,sizeof(ULONG_PTR),old,&old);
   }
  }
 }
 return TRUE;
}
