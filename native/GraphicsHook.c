#define COBJMACROS
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <d3d11.h>
#include <dxgi.h>
#include <dxgi1_2.h>
#include <stdint.h>
#include <string.h>
#include <stdio.h>
#include <math.h>
#include <wchar.h>
#include <bcrypt.h>
#include "MinHook.h"

// Shared-memory ABI v2. Offset 80 acknowledges the consumed frame sequence.
// Only pixels for the exact requested output HWND are read.
typedef struct {
 uint32_t magic,pid; uint64_t window; uint32_t owner,stop,status,fps,max_width,width,height,stride,bytes;
 volatile LONG sequence; uint64_t captured; uint32_t error; BYTE reserved[184];
} Control;
_Static_assert(sizeof(Control)==256,"shared ABI");
#define CAPACITY (64u*1024u*1024u)
typedef HRESULT (STDMETHODCALLTYPE *PresentFn)(IDXGISwapChain*,UINT,UINT);
typedef HRESULT (STDMETHODCALLTYPE *Present1Fn)(IDXGISwapChain1*,UINT,UINT,const DXGI_PRESENT_PARAMETERS*);
static PresentFn original_present;
static Present1Fn original_present1;
static HINSTANCE own_module;
static Control* control;
static volatile LONG busy,inside,started;
static ID3D11Device* device;
static ID3D11DeviceContext* context;
static ID3D11Texture2D* stage[2];
static UINT tex_width,tex_height,tex_format,slot;
static BOOL copied[2];
static ULONGLONG last_tick;
static BYTE half_srgb[65536];
// Optional private input extension inside the ABI's reserved bytes. Only the
// exact isolated Scene or reviewed Sheep process/Job may enable it. Input reads
// are virtualized inside that process; the system cursor and focus never move.
typedef BOOL (WINAPI *CursorFn)(LPPOINT);
typedef SHORT (WINAPI *KeyFn)(int);
typedef HWND (WINAPI *WindowAtFn)(POINT);
typedef BOOL (WINAPI *KeyboardFn)(PBYTE);
typedef UINT (WINAPI *RawInputFn)(HRAWINPUT,UINT,LPVOID,PUINT,UINT);
static CursorFn original_cursor,original_physical_cursor;
static KeyFn original_key,original_async_key;
static WindowAtFn original_window_at;
static KeyboardFn original_keyboard;
static RawInputFn original_raw_input;
static BOOL private_pointer,private_application;
static BOOL private_guid(UINT offset,WCHAR token[37]) {
 for(UINT index=0;index<36;index++) {
  char c=*((char*)control+offset+index);
  if(index==8||index==13||index==18||index==23){if(c!='-')return FALSE;}
  else if(!((c>='0'&&c<='9')||(c>='a'&&c<='f')))return FALSE;
  token[index]=(WCHAR)c;
 }
 token[36]=0;return *((char*)control+offset+36)==0;
}
static BOOL private_job(const WCHAR* name) {
 HANDLE job=OpenJobObjectW(JOB_OBJECT_QUERY,FALSE,name);if(!job)return FALSE;
 BOOL member=FALSE;BOOL checked=IsProcessInJob(GetCurrentProcess(),job,&member);CloseHandle(job);
 return checked&&member;
}
static BOOL private_scene_identity(void) {
 WCHAR token[37],actual[MAX_PATH],temporary[MAX_PATH],expected[MAX_PATH],job_name[128];
 if(!private_guid(128,token))return FALSE;
 if(!GetModuleFileNameW(NULL,actual,MAX_PATH)||!GetTempPathW(MAX_PATH,temporary))return FALSE;
 if(_snwprintf(expected,MAX_PATH,L"%lscwb-runtime-%ls\\wallpaper64.exe",temporary,token)<0||_wcsicmp(actual,expected)!=0)return FALSE;
 _snwprintf(job_name,128,L"Local\\CodexWallpaperBridge.Isolated.%ls",token);
 return private_job(job_name);
}
// Bounded marker parser: selected fields must occur exactly once and be JSON
// strings. The staging writer emits ASCII paths with only backslash escapes.
static BOOL marker_string(const char* json,const char* key,WCHAR* result,UINT capacity) {
 char name[80];snprintf(name,sizeof(name),"\"%s\"",key);const char* start=strstr(json,name);if(!start||strstr(start+strlen(name),name))return FALSE;
 start+=strlen(name);while(*start==' '||*start=='\r'||*start=='\n'||*start=='\t')start++;if(*start++!=':')return FALSE;
 while(*start==' '||*start=='\r'||*start=='\n'||*start=='\t')start++;if(*start++!='\"')return FALSE;
 UINT size=0;for(;*start&&*start!='\"';start++) {
  unsigned char value=(unsigned char)*start;if(value<32||value>=128||size+1>=capacity)return FALSE;
  if(value=='\\'){start++;value=(unsigned char)*start;if(value!='\\'&&value!='/'&&value!='\"')return FALSE;}
  result[size++]=(WCHAR)value;
 }
 if(*start!='\"')return FALSE;result[size]=0;return TRUE;
}
static BOOL file_hash(const WCHAR* file,const char* expected) {
 // Resolve the system CNG implementation without extending the DLL imports.
 HMODULE bcrypt=LoadLibraryW(L"bcrypt.dll");if(!bcrypt)return FALSE;
 typedef NTSTATUS (WINAPI *OpenFn)(BCRYPT_ALG_HANDLE*,LPCWSTR,LPCWSTR,ULONG);
 typedef NTSTATUS (WINAPI *CreateFn)(BCRYPT_ALG_HANDLE,BCRYPT_HASH_HANDLE*,PUCHAR,ULONG,PUCHAR,ULONG,ULONG);
 typedef NTSTATUS (WINAPI *DataFn)(BCRYPT_HASH_HANDLE,PUCHAR,ULONG,ULONG);
 typedef NTSTATUS (WINAPI *FinishFn)(BCRYPT_HASH_HANDLE,PUCHAR,ULONG,ULONG);
 typedef NTSTATUS (WINAPI *DestroyFn)(BCRYPT_HASH_HANDLE);
 typedef NTSTATUS (WINAPI *CloseFn)(BCRYPT_ALG_HANDLE,ULONG);
 OpenFn open=(OpenFn)GetProcAddress(bcrypt,"BCryptOpenAlgorithmProvider");CreateFn create=(CreateFn)GetProcAddress(bcrypt,"BCryptCreateHash");
 DataFn data=(DataFn)GetProcAddress(bcrypt,"BCryptHashData");FinishFn finish=(FinishFn)GetProcAddress(bcrypt,"BCryptFinishHash");
 DestroyFn destroy=(DestroyFn)GetProcAddress(bcrypt,"BCryptDestroyHash");CloseFn close=(CloseFn)GetProcAddress(bcrypt,"BCryptCloseAlgorithmProvider");
 HANDLE input=INVALID_HANDLE_VALUE;BCRYPT_ALG_HANDLE algorithm=NULL;BCRYPT_HASH_HANDLE hash=NULL;BOOL success=FALSE;BYTE buffer[32768],digest[32];DWORD count;
 if(!open||!create||!data||!finish||!destroy||!close)goto end;
 input=CreateFileW(file,GENERIC_READ,FILE_SHARE_READ,NULL,OPEN_EXISTING,FILE_FLAG_SEQUENTIAL_SCAN,NULL);if(input==INVALID_HANDLE_VALUE)goto end;
 if(open(&algorithm,BCRYPT_SHA256_ALGORITHM,NULL,0)<0||create(algorithm,&hash,NULL,0,NULL,0,0)<0)goto end;
 for(;;){if(!ReadFile(input,buffer,sizeof(buffer),&count,NULL))goto end;if(!count)break;if(data(hash,buffer,count,0)<0)goto end;}
 if(finish(hash,digest,32,0)<0)goto end;
 for(UINT n=0;n<32;n++) {static const char hex[]="0123456789abcdef";if(expected[n*2]!=hex[digest[n]>>4]||expected[n*2+1]!=hex[digest[n]&15])goto end;}
 success=TRUE;
end:
 if(hash)destroy(hash);if(algorithm)close(algorithm,0);if(input!=INVALID_HANDLE_VALUE)CloseHandle(input);FreeLibrary(bcrypt);return success;
}
static BOOL private_application_identity(void) {
 WCHAR token[37],session[37],actual[MAX_PATH],root[MAX_PATH],source[MAX_PATH],value[MAX_PATH],file[MAX_PATH],job_name[128];
 if(!private_guid(128,token)||!private_guid(172,session)||!GetModuleFileNameW(NULL,actual,MAX_PATH))return FALSE;
 WCHAR* leaf=wcsrchr(actual,L'\\');if(!leaf||_wcsicmp(leaf+1,L"sheep.exe"))return FALSE;
 wcscpy(root,actual);root[leaf-actual]=0;WCHAR* runtime=wcsrchr(root,L'\\');if(!runtime||wcscmp(runtime+1,token))return FALSE;
 *runtime=0;WCHAR* base=wcsrchr(root,L'\\');if(!base||wcscmp(base+1,L".bridge-application-runtime"))return FALSE;*base=0;
 if(_snwprintf(source,MAX_PATH,L"%ls\\projects\\defaultprojects\\sheep",root)<0||_snwprintf(file,MAX_PATH,L"%ls\\.bridge-application-runtime\\%ls\\.bridge-application.json",root,token)<0)return FALSE;
 HANDLE input=CreateFileW(file,GENERIC_READ,FILE_SHARE_READ,NULL,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,NULL);if(input==INVALID_HANDLE_VALUE)return FALSE;
 DWORD length=GetFileSize(input,NULL),read=0;char* marker=NULL;BOOL valid=FALSE;
 if(length>0&&length<=65536){marker=(char*)HeapAlloc(GetProcessHeap(),0,length+1);if(marker&&ReadFile(input,marker,length,&read,NULL)&&read==length)marker[length]=0;else {if(marker)HeapFree(GetProcessHeap(),0,marker);marker=NULL;}}
 CloseHandle(input);if(!marker)return FALSE;
 if(!marker_string(marker,"token",value,MAX_PATH)||wcscmp(value,token)||!marker_string(marker,"profile",value,MAX_PATH)||wcscmp(value,L"unity-2017.2-reviewed-sheep")||
  !marker_string(marker,"originalTree",value,MAX_PATH)||wcscmp(value,L"e09a40b06aafadf8e5d9603a5ca0884ce953b1ad550724044ef3a52e3b414d4a")||
  !marker_string(marker,"sourceRoot",value,MAX_PATH)||_wcsicmp(value,source))goto end;
 _snwprintf(file,MAX_PATH,L"%ls\\sheep.exe",source);if(!marker_string(marker,"sourceFile",value,MAX_PATH)||_wcsicmp(value,file))goto end;
 if(!file_hash(actual,"ca6df88664e1f4088ec7632584ba9486eedec3e800d3fcc2c749a7d019440d64"))goto end;
 *leaf=0;
 _snwprintf(file,MAX_PATH,L"%ls\\UnityPlayer.dll",actual);if(!file_hash(file,"30a16cbb616ffee4d430e948f484f5689379caccdd070bfb213efd629f581b60"))goto end;
 _snwprintf(file,MAX_PATH,L"%ls\\sheep_Data\\globalgamemanagers",actual);if(!file_hash(file,"581fb0d10cfdccd925e7b7b43813ce98c1bc7a2b17c249279f9f9f5f2b3985f7"))goto end;
 _snwprintf(file,MAX_PATH,L"%ls\\sheep_Data\\Managed\\Assembly-CSharp.dll",actual);if(!file_hash(file,"4b342c65a75118fce25d4bfa143a7089e02a6dc0db11f2348ae4520d8d40fee5"))goto end;
 _snwprintf(job_name,128,L"Local\\CodexWallpaperBridge.Application.%ls",session);valid=private_job(job_name);
end:
 HeapFree(GetProcessHeap(),0,marker);return valid;
}
static BOOL private_point(POINT* point) {
 if(!private_pointer||!control||control->stop)return FALSE;
 LONG before=InterlockedCompareExchange((volatile LONG*)((BYTE*)control+88),0,0);
 LONG x=*(volatile LONG*)((BYTE*)control+92),y=*(volatile LONG*)((BYTE*)control+96);
 BOOL valid=!(before&1)&&*(volatile LONG*)((BYTE*)control+100)!=0;
 MemoryBarrier();if(before!=InterlockedCompareExchange((volatile LONG*)((BYTE*)control+88),0,0))valid=FALSE;
 RECT rect;HWND window=(HWND)(uintptr_t)control->window;if(!GetClientRect(window,&rect))return FALSE;
 point->x=valid?x:(rect.right/2);point->y=valid?y:(rect.bottom/2);
 return ClientToScreen(window,point);
}
static BOOL WINAPI cursor_hook(LPPOINT point) {
 InterlockedIncrement(&inside);
 if(private_application&&control)InterlockedIncrement((volatile LONG*)((BYTE*)control+212));
 BOOL result=point&&private_point(point);if(!result)result=original_cursor(point);InterlockedDecrement(&inside);return result;
}
static BOOL WINAPI physical_cursor_hook(LPPOINT point) {
 InterlockedIncrement(&inside);BOOL result=point&&private_point(point);if(!result)result=original_physical_cursor(point);InterlockedDecrement(&inside);return result;
}
static SHORT private_button(void) {
 if(!control||control->stop)return 0;
 ULONGLONG until=*(volatile ULONGLONG*)((BYTE*)control+112),now=GetTickCount64();
 BOOL down=until>now&&until-now<=120;return down?(SHORT)0x8000:0;
}
static SHORT WINAPI key_hook(int key) {
 InterlockedIncrement(&inside);
 if(private_application&&control&&key==VK_LBUTTON)InterlockedIncrement((volatile LONG*)((BYTE*)control+216));
 // GetKeyState exposes a sign-extended keyboard-state byte. WE 2.8 tests
 // HIBYTE(state)&1; returning only 0x8000 would pass the documented high-bit
 // check but fail that observed consumer. GetAsyncKeyState stays 0x8000.
 SHORT result=private_pointer&&key==VK_LBUTTON?(private_button()?(SHORT)0xff80:0):private_application?0:original_key(key);InterlockedDecrement(&inside);return result;
}
static SHORT WINAPI async_key_hook(int key) {
 InterlockedIncrement(&inside);
 if(private_application&&control&&key==VK_LBUTTON)InterlockedIncrement((volatile LONG*)((BYTE*)control+216));
 SHORT result=private_pointer&&key==VK_LBUTTON?private_button():private_application?0:original_async_key(key);InterlockedDecrement(&inside);return result;
}
static BOOL WINAPI keyboard_hook(PBYTE keys) {
 InterlockedIncrement(&inside);BOOL result;
 if(private_application&&keys){ZeroMemory(keys,256);keys[VK_LBUTTON]=private_button()?0x80:0;result=TRUE;}
 else result=original_keyboard(keys);
 InterlockedDecrement(&inside);return result;
}
static UINT WINAPI raw_input_hook(HRAWINPUT handle,UINT command,LPVOID data,PUINT size,UINT header_size) {
 InterlockedIncrement(&inside);UINT result;
 // Suppress real raw-input packets in this reviewed process, including the
 // physical keyboard and mouse. Only the explicit bridge pointer is forwarded.
 if(private_application){if(size)*size=0;SetLastError(ERROR_ACCESS_DENIED);result=(UINT)-1;}
 else result=original_raw_input(handle,command,data,size,header_size);
 InterlockedDecrement(&inside);return result;
}
static HWND WINAPI window_at_hook(POINT point) {
 InterlockedIncrement(&inside);HWND result=NULL;
 if(private_pointer&&control&&!control->stop) {
  HWND window=(HWND)(uintptr_t)control->window;RECT client;
  if(GetClientRect(window,&client)) {
   POINT corner={0,0};if(ClientToScreen(window,&corner)&&point.x>=corner.x&&point.y>=corner.y&&
    point.x<corner.x+client.right&&point.y<corner.y+client.bottom)result=window;
  }
 }
 if(!result)result=original_window_at(point);InterlockedDecrement(&inside);return result;
}
static void init_half_srgb(void) {
 // scRGB/linear FP16 -> bounded SDR sRGB. Values above SDR white clip;
 // this path does not claim HDR color fidelity. LUT keeps pow off Present.
 for(UINT bits=0;bits<65536;bits++) {
  UINT exponent=(bits>>10)&31,mantissa=bits&1023;float linear;
  if(bits&32768)linear=0;
  else if(exponent==31)linear=mantissa?0:1;
  else if(exponent==0)linear=mantissa/16777216.0f;
  else {union {UINT bits;float value;} value;value.bits=((exponent+112)<<23)|(mantissa<<13);linear=value.value;}
  if(linear>1)linear=1;
  float encoded=linear<=0.0031308f?12.92f*linear:1.055f*powf(linear,1.0f/2.4f)-0.055f;
  half_srgb[bits]=(BYTE)(encoded*255.0f+0.5f);
 }
}
static void clear_gpu(void) {
 for(int i=0;i<2;i++){if(stage[i])ID3D11Texture2D_Release(stage[i]);stage[i]=NULL;copied[i]=FALSE;}
 if(context)ID3D11DeviceContext_Release(context);context=NULL;
 if(device)ID3D11Device_Release(device);device=NULL;
 tex_width=tex_height=tex_format=slot=0;
}
static void capture(IDXGISwapChain* swap) {
 if(!control || control->stop || control->fps==0)return;
 DXGI_SWAP_CHAIN_DESC desc;if(FAILED(IDXGISwapChain_GetDesc(swap,&desc)) || desc.OutputWindow!=(HWND)(uintptr_t)control->window)return;
 LONG published=InterlockedCompareExchange(&control->sequence,0,0);
 if(published!=0 && InterlockedCompareExchange((volatile LONG*)((BYTE*)control+80),0,0)!=published)return;
 ULONGLONG now=GetTickCount64();UINT fps=control->fps;if(fps>120)fps=120;
 if(now-last_tick<1000/fps || InterlockedCompareExchange(&busy,1,0)!=0)return;
 published=InterlockedCompareExchange(&control->sequence,0,0);
 if(published!=0 && InterlockedCompareExchange((volatile LONG*)((BYTE*)control+80),0,0)!=published){InterlockedExchange(&busy,0);return;}
 last_tick=now;
 ID3D11Texture2D* texture=NULL;
 HRESULT hr=IDXGISwapChain_GetBuffer(swap,0,&IID_ID3D11Texture2D,(void**)&texture);
 if(FAILED(hr)||!texture)goto done;
 D3D11_TEXTURE2D_DESC td;ID3D11Texture2D_GetDesc(texture,&td);
 *(volatile UINT*)((BYTE*)control+76)=td.Format;
 if(td.Width==0 || td.Height==0 || (uint64_t)td.Width*td.Height>16777216 || td.SampleDesc.Count!=1)goto release;
 if(td.Format!=DXGI_FORMAT_B8G8R8A8_UNORM && td.Format!=DXGI_FORMAT_R8G8B8A8_UNORM && td.Format!=DXGI_FORMAT_B8G8R8A8_UNORM_SRGB && td.Format!=DXGI_FORMAT_R8G8B8A8_UNORM_SRGB && td.Format!=DXGI_FORMAT_R16G16B16A16_FLOAT){control->error=10;goto release;}
 control->error=0;
 ID3D11Device* actual_device=NULL;ID3D11Texture2D_GetDevice(texture,&actual_device);
 BOOL changed=actual_device!=device;if(actual_device)ID3D11Device_Release(actual_device);
 if(!device || changed || td.Width!=tex_width || td.Height!=tex_height || td.Format!=tex_format) {
  clear_gpu();
  if(FAILED(IDXGISwapChain_GetDevice(swap,&IID_ID3D11Device,(void**)&device)))goto release;
  ID3D11Device_GetImmediateContext(device,&context);
  tex_width=td.Width;tex_height=td.Height;tex_format=td.Format;
  td.Usage=D3D11_USAGE_STAGING;td.BindFlags=0;td.CPUAccessFlags=D3D11_CPU_ACCESS_READ;td.MiscFlags=0;td.MipLevels=1;td.ArraySize=1;
  for(int i=0;i<2;i++)if(FAILED(ID3D11Device_CreateTexture2D(device,&td,NULL,&stage[i]))) {clear_gpu();goto release;}
 }
 UINT read_slot=slot^1;
 ID3D11DeviceContext_CopyResource(context,(ID3D11Resource*)stage[slot],(ID3D11Resource*)texture);copied[slot]=TRUE;slot=read_slot;
 if(!copied[read_slot])goto release;
 D3D11_MAPPED_SUBRESOURCE map;
 hr=ID3D11DeviceContext_Map(context,(ID3D11Resource*)stage[read_slot],0,D3D11_MAP_READ,D3D11_MAP_FLAG_DO_NOT_WAIT,&map);
 if(FAILED(hr))goto release;
 UINT width=control->max_width;if(width<320)width=320;if(width>1920)width=1920;if(width>tex_width)width=tex_width;
 UINT height=(UINT)((uint64_t)tex_height*width/tex_width);if(height==0)height=1;
 if((uint64_t)width*height*4<=CAPACITY) {
  InterlockedIncrement(&control->sequence);
  BYTE* dst=(BYTE*)control+256;
  BOOL rgba=(tex_format==DXGI_FORMAT_R8G8B8A8_UNORM || tex_format==DXGI_FORMAT_R8G8B8A8_UNORM_SRGB);
  BOOL fp16=tex_format==DXGI_FORMAT_R16G16B16A16_FLOAT;
  for(UINT y=0;y<height;y++) {
   BYTE* row=(BYTE*)map.pData+((uint64_t)y*tex_height/height)*map.RowPitch;
   for(UINT x=0;x<width;x++) {
    BYTE* src=row+((uint64_t)x*tex_width/width)*(fp16?8:4);BYTE* pixel=dst+((uint64_t)y*width+x)*4;
    if(fp16){const UINT16* half=(const UINT16*)src;pixel[0]=half_srgb[half[2]];pixel[1]=half_srgb[half[1]];pixel[2]=half_srgb[half[0]];}
    else {pixel[0]=src[rgba?2:0];pixel[1]=src[1];pixel[2]=src[rgba?0:2];}pixel[3]=255;
   }
  }
  control->width=width;control->height=height;control->stride=width*4;control->bytes=width*height*4;control->captured++;
  MemoryBarrier();InterlockedIncrement(&control->sequence);control->status=2;
 }
 ID3D11DeviceContext_Unmap(context,(ID3D11Resource*)stage[read_slot],0);
release: ID3D11Texture2D_Release(texture);
done: InterlockedExchange(&busy,0);
}
static HRESULT STDMETHODCALLTYPE present_hook(IDXGISwapChain* swap,UINT interval,UINT flags) {
 InterlockedIncrement(&inside);if(control)InterlockedIncrement((volatile LONG*)((BYTE*)control+72));
 capture(swap);HRESULT result=original_present(swap,interval,flags);InterlockedDecrement(&inside);return result;
}
static HRESULT STDMETHODCALLTYPE present1_hook(IDXGISwapChain1* swap,UINT interval,UINT flags,const DXGI_PRESENT_PARAMETERS* parameters) {
 InterlockedIncrement(&inside);if(control)InterlockedIncrement((volatile LONG*)((BYTE*)control+72));
 capture((IDXGISwapChain*)swap);HRESULT result=original_present1(swap,interval,flags,parameters);InterlockedDecrement(&inside);return result;
}
__declspec(dllexport) DWORD WINAPI CwbStart(const WCHAR* mapping_name) {
 if(InterlockedCompareExchange(&started,1,0)!=0)return 1;
 HANDLE mapping=OpenFileMappingW(FILE_MAP_ALL_ACCESS,FALSE,mapping_name),owner=NULL;
 HWND dummy=NULL;IDXGISwapChain* swap=NULL;ID3D11Device* test_device=NULL;ID3D11DeviceContext* test_context=NULL;
 void* target=NULL;void* target1=NULL;BOOL initialized=FALSE,enabled=FALSE,orphan=FALSE;
 if(!mapping)goto end;
 control=(Control*)MapViewOfFile(mapping,FILE_MAP_ALL_ACCESS,0,0,256+CAPACITY);
 if(!control || control->magic!=0x32425743 || control->pid!=GetCurrentProcessId())goto end;
 DWORD pid=0;GetWindowThreadProcessId((HWND)(uintptr_t)control->window,&pid);
 if(pid!=GetCurrentProcessId())goto end;
 owner=OpenProcess(SYNCHRONIZE,FALSE,control->owner);if(!owner)goto end;
 init_half_srgb();
 dummy=CreateWindowExW(0,L"STATIC",L"CWB D3D discovery",WS_POPUP,0,0,16,16,NULL,NULL,NULL,NULL);if(!dummy)goto end;
 DXGI_SWAP_CHAIN_DESC sd;ZeroMemory(&sd,sizeof(sd));sd.BufferCount=2;sd.BufferDesc.Width=16;sd.BufferDesc.Height=16;
 sd.BufferDesc.Format=DXGI_FORMAT_B8G8R8A8_UNORM;sd.BufferUsage=DXGI_USAGE_RENDER_TARGET_OUTPUT;sd.OutputWindow=dummy;sd.SampleDesc.Count=1;sd.Windowed=TRUE;sd.SwapEffect=DXGI_SWAP_EFFECT_FLIP_DISCARD;
 if(FAILED(D3D11CreateDeviceAndSwapChain(NULL,D3D_DRIVER_TYPE_HARDWARE,NULL,0,NULL,0,D3D11_SDK_VERSION,&sd,&swap,&test_device,NULL,&test_context)))goto end;
 target=(*(void***)swap)[8];
 IDXGISwapChain1* swap1=NULL;
 if(SUCCEEDED(IDXGISwapChain_QueryInterface(swap,&IID_IDXGISwapChain1,(void**)&swap1))){target1=(*(void***)swap1)[22];IDXGISwapChain1_Release(swap1);}
 if(control->stop || WaitForSingleObject(owner,0)==WAIT_OBJECT_0)goto end;
 if(MH_Initialize()!=MH_OK)goto end;initialized=TRUE;
 if(MH_CreateHook(target,present_hook,(void**)&original_present)!=MH_OK)goto end;
 if(target1 && MH_CreateHook(target1,present1_hook,(void**)&original_present1)!=MH_OK)goto end;
 UINT pointer_profile=*(volatile UINT*)((BYTE*)control+84);
 if(pointer_profile==0x31505743||pointer_profile==0x32505743) {
  private_application=pointer_profile==0x32505743;
  if(!(private_application?private_application_identity():private_scene_identity())){*(volatile UINT*)((BYTE*)control+168)=2;goto end;}
  HMODULE user=GetModuleHandleW(L"user32.dll");
  void* cursor=(void*)GetProcAddress(user,"GetCursorPos"),*physical=(void*)GetProcAddress(user,"GetPhysicalCursorPos");
  void* key=(void*)GetProcAddress(user,"GetKeyState"),*async_key=(void*)GetProcAddress(user,"GetAsyncKeyState");
  void* window_at=(void*)GetProcAddress(user,"WindowFromPoint");
  if(!cursor||!key||MH_CreateHook(cursor,cursor_hook,(void**)&original_cursor)!=MH_OK||MH_CreateHook(key,key_hook,(void**)&original_key)!=MH_OK)goto end;
  if(physical&&physical!=cursor&&MH_CreateHook(physical,physical_cursor_hook,(void**)&original_physical_cursor)!=MH_OK)goto end;
  if(async_key&&async_key!=key&&MH_CreateHook(async_key,async_key_hook,(void**)&original_async_key)!=MH_OK)goto end;
  if(window_at&&MH_CreateHook(window_at,window_at_hook,(void**)&original_window_at)!=MH_OK)goto end;
  if(private_application) {
   void* keyboard=(void*)GetProcAddress(user,"GetKeyboardState"),*raw=(void*)GetProcAddress(user,"GetRawInputData");
   if(!keyboard||!raw||MH_CreateHook(keyboard,keyboard_hook,(void**)&original_keyboard)!=MH_OK||MH_CreateHook(raw,raw_input_hook,(void**)&original_raw_input)!=MH_OK)goto end;
  }
  private_pointer=TRUE;
 }
 if(MH_EnableHook(MH_ALL_HOOKS)!=MH_OK)goto end;enabled=TRUE;control->status=1;
 if(private_pointer)*(volatile UINT*)((BYTE*)control+168)=1;
 while(!control->stop && WaitForSingleObject(owner,100)==WAIT_TIMEOUT) { DWORD current=0;GetWindowThreadProcessId((HWND)(uintptr_t)control->window,&current);if(current!=GetCurrentProcessId())break; }
end:
 if(enabled)MH_DisableHook(MH_ALL_HOOKS);
 while(InterlockedCompareExchange(&inside,0,0)!=0)Sleep(1);
 private_pointer=private_application=FALSE;
 clear_gpu();if(initialized)MH_Uninitialize();
 if(test_context)ID3D11DeviceContext_Release(test_context);if(test_device)ID3D11Device_Release(test_device);if(swap)IDXGISwapChain_Release(swap);if(dummy)DestroyWindow(dummy);
 if(owner && WaitForSingleObject(owner,0)==WAIT_OBJECT_0)orphan=TRUE;
 if(control){control->status=3;UnmapViewOfFile(control);control=NULL;}
 if(mapping)CloseHandle(mapping);if(owner)CloseHandle(owner);
 InterlockedExchange(&started,0);
 if(orphan){Sleep(100);FreeLibraryAndExitThread(own_module,0);}
 return 0;
}
BOOL WINAPI DllMain(HINSTANCE module,DWORD reason,LPVOID unused){if(reason==DLL_PROCESS_ATTACH){own_module=module;DisableThreadLibraryCalls(module);}return TRUE;}
