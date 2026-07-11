import viteSvg from '../assets/vite.svg'

function Loading() {
    return (
        <div className="flex items-center">
            <div
                className="rounded-full w-11 h-11 border-2 border-[#2d2d2d] -ml-8 first:ml-0 flex justify-center items-center bg-[#3d3d3d] relative"
            >
                {/* 发送方的头像 */}
                <img src={viteSvg} alt="" />
            </div>

            <div className="flex items-center gap-1.5 px-5">
                {[0, 1, 2].map(i => (
                    <div
                        key={i}
                        className="w-1 h-1 bg-amber-50/60 rounded-full"
                        style={{
                            animation: `dot-wave 1.4s ease-in-out ${i * 0.2}s infinite`,
                        }}
                    />
                ))}
            </div>

            {/* 接受者的头像 允许多个（群组） */}
            <div className="flex items-center">
                {Array.from({ length: 5 }).map((_, i) => (
                    <div
                        key={i}
                        className="rounded-full w-11 h-11 border-2 border-[#2d2d2d] -ml-6 first:ml-0 flex justify-center items-center bg-[#3d3d3d] relative"
                    >
                        <img src={viteSvg} alt="" />
                    </div>
                ))}
            </div>
        </div>
    )
}

export default Loading